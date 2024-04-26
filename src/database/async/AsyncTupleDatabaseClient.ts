import { randomId } from "../../helpers/randomId"
import * as t from "../../helpers/sortedTupleArray"
import * as tv from "../../helpers/sortedTupleValuePairs"
import {
	normalizeSubspaceScanArgs,
	prependPrefixToTuple,
	prependPrefixToWriteOps,
	removePrefixFromTuple,
	removePrefixFromTupleValuePairs,
	removePrefixFromWriteOps,
} from "../../helpers/subspaceHelpers"
import { decodeTuple, encodeTuple } from "../../main"
import { KeyValuePair, Tuple, WriteOps } from "../../storage/types"
import { TupleDatabaseApi } from "../sync/types"
import {
	FilterTupleValuePairByPrefix,
	RemoveTupleValuePairPrefix,
	TuplePrefix,
	ValueForTuple,
} from "../typeHelpers"
import { ScanArgs, TxId, Unsubscribe } from "../types"
import {
	AsyncCallback,
	AsyncTupleDatabaseApi,
	AsyncTupleDatabaseClientApi,
	AsyncTupleRootTransactionApi,
	AsyncTupleTransactionApi,
} from "./asyncTypes"

export class AsyncTupleDatabaseClient<S extends KeyValuePair = KeyValuePair>
	implements AsyncTupleDatabaseClientApi<S>
{
	constructor(
		private db: AsyncTupleDatabaseApi | TupleDatabaseApi,
		public subspacePrefix: Tuple = []
	) {}

	async scan<T extends S["key"], P extends TuplePrefix<T>>(
		args: ScanArgs<T, P> = {},
		txId?: TxId
	): Promise<FilterTupleValuePairByPrefix<S, P>[]> {
		const storageScanArgs = normalizeSubspaceScanArgs(this.subspacePrefix, args)
		const pairs = await this.db.scan(storageScanArgs, txId)
		const result = removePrefixFromTupleValuePairs(this.subspacePrefix, pairs)
		return result as FilterTupleValuePairByPrefix<S, P>[]
	}

	async subscribe<T extends S["key"], P extends TuplePrefix<T>>(
		args: ScanArgs<T, P>,
		callback: AsyncCallback<FilterTupleValuePairByPrefix<S, P>>
	): Promise<Unsubscribe> {
		const storageScanArgs = normalizeSubspaceScanArgs(this.subspacePrefix, args)
		return this.db.subscribe(storageScanArgs, (write, txId) => {
			return callback(
				removePrefixFromWriteOps(this.subspacePrefix, write) as WriteOps<
					FilterTupleValuePairByPrefix<S, P>
				>,
				txId
			)
		})
	}

	async commit(writes: WriteOps<S>, txId?: TxId): Promise<void> {
		const prefixedWrites = prependPrefixToWriteOps(this.subspacePrefix, writes)
		await this.db.commit(prefixedWrites, txId)
	}

	async cancel(txId: string) {
		return this.db.cancel(txId)
	}

	async get<T extends S["key"]>(
		tuple: T,
		txId?: TxId
	): Promise<ValueForTuple<S, T> | undefined> {
		// Not sure why these types aren't happy
		// @ts-ignore
		const items = await this.scan<T, []>({ gte: tuple, lte: tuple }, txId)
		if (items.length === 0) return
		if (items.length > 1) throw new Error("Get expects only one value.")
		const pair = items[0]
		return pair.value
	}

	async exists<T extends S["key"]>(tuple: T, txId?: TxId): Promise<boolean> {
		// Not sure why these types aren't happy
		// @ts-ignore
		const items = await this.scan({ gte: tuple, lte: tuple }, txId)
		if (items.length === 0) return false
		return items.length >= 1
	}

	// Subspace
	subspace<P extends TuplePrefix<S["key"]>>(
		prefix: P
	): AsyncTupleDatabaseClient<RemoveTupleValuePairPrefix<S, P>> {
		const subspacePrefix = [...this.subspacePrefix, ...prefix]
		return new AsyncTupleDatabaseClient(this.db, subspacePrefix)
	}

	// Transaction
	transact(txId?: TxId, writes?: WriteOps<S>): AsyncTupleRootTransactionApi<S> {
		const id = txId || randomId()
		return new AsyncTupleRootTransaction(
			this.db,
			this.subspacePrefix,
			id,
			writes
		)
	}

	async close() {
		return this.db.close()
	}
}

export class AsyncTupleRootTransaction<S extends KeyValuePair>
	implements AsyncTupleRootTransactionApi<S>
{
	committed = false
	canceled = false
	private _writes: { set: S[]; remove: Set<string> }

	// Track whether writes are dirty and need to be sorted prior to reading
	private setsDirty = false

	constructor(
		private db: AsyncTupleDatabaseApi | TupleDatabaseApi,
		public subspacePrefix: Tuple,
		public id: TxId,
		writes?: WriteOps<S>
	) {
		this._writes = {
			set: writes?.set ?? [],
			remove:
				writes?.remove === undefined
					? new Set()
					: new Set(writes.remove.map((k) => encodeTuple(k))),
		}
	}

	get writes() {
		return {
			set: this._writes.set.filter(({ key }) => {
				const encodedKey = encodeTuple(key)
				const isRemoved = this._writes.remove.has(encodedKey)
				return !isRemoved
			}),
			remove: Array.from(this._writes.remove).map(decodeTuple),
		}
	}

	private cleanWrites() {
		this.cleanSets()
	}

	private cleanSets() {
		if (this.setsDirty) {
			this._writes.set = this._writes.set.sort(tv.compareTupleValuePair)
			this.setsDirty = false
		}
	}

	private checkActive() {
		if (this.committed) throw new Error("Transaction already committed")
		if (this.canceled) throw new Error("Transaction already canceled")
	}

	async scan<T extends S["key"], P extends TuplePrefix<T>>(
		args: ScanArgs<T, P> = {}
	): Promise<FilterTupleValuePairByPrefix<S, P>[]> {
		this.checkActive()
		this.cleanWrites()

		const { limit: resultLimit, ...scanArgs } = normalizeSubspaceScanArgs(
			this.subspacePrefix,
			args
		)

		// We don't want to include the limit in this scan.
		const txTuples = tv.scan(this._writes.set, scanArgs)

		// If we've removed items from this range, then lets make sure to fetch enough
		// from storage for the final result limit.
		const scanLimit = resultLimit
			? resultLimit + this._writes.remove.size
			: undefined
		const dbTuples = await this.db.scan(
			{ ...scanArgs, limit: scanLimit },
			this.id
		)
		let result = dbTuples

		for (const { key: tuple, value } of txTuples) {
			// Make sure we insert in reverse if the scan is in reverse.
			tv.set(result, tuple, value, scanArgs.reverse)
		}

		if (this._writes.remove.size > 0) {
			result = result.filter(
				({ key }) => !this._writes.remove.has(encodeTuple(key))
			)
		}

		if (this.subspacePrefix && this.subspacePrefix.length > 0) {
			result = result.map(
				(tuple) =>
					({
						key: removePrefixFromTuple(this.subspacePrefix, tuple.key),
						value: tuple.value,
					} as S)
			)
		}
		// Make sure to truncate the results if we added items to the result set.
		if (resultLimit) {
			if (result.length > resultLimit) {
				result.splice(resultLimit, result.length)
			}
		}

		return result as FilterTupleValuePairByPrefix<S, P>[]
	}

	async get<T extends S["key"]>(
		tuple: T
	): Promise<ValueForTuple<S, T> | undefined> {
		this.checkActive()
		this.cleanWrites()
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)

		if (tv.exists(this._writes.set, fullTuple)) {
			// TODO: binary searching twice unnecessarily...
			return tv.get(this._writes.set, fullTuple)
		}
		if (this._writes.remove.has(encodeTuple(fullTuple))) {
			return
		}
		const items = await this.db.scan(
			{ gte: fullTuple, lte: fullTuple },
			this.id
		)
		if (items.length === 0) return
		if (items.length > 1) throw new Error("Get expects only one value.")
		const pair = items[0]
		return pair.value
	}

	async exists<T extends S["key"]>(tuple: T): Promise<boolean> {
		this.checkActive()
		this.cleanWrites()
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)

		if (this._writes.remove.has(encodeTuple(fullTuple))) {
			return false
		}
		if (tv.exists(this._writes.set, fullTuple)) {
			return true
		}

		const items = await this.db.scan(
			{ gte: fullTuple, lte: fullTuple },
			this.id
		)
		if (items.length === 0) return false
		return items.length >= 1
	}

	// ReadApis
	set<T extends S>(
		tuple: T["key"],
		value: T["value"]
	): AsyncTupleRootTransactionApi<S> {
		this.checkActive()
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)
		this._writes.remove.delete(encodeTuple(fullTuple))
		this._writes.set.push({ key: fullTuple, value: value } as S)
		this.setsDirty = true
		return this
	}

	remove(tuple: S["key"]): AsyncTupleRootTransactionApi<S> {
		this.checkActive()
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)
		this._writes.remove.add(encodeTuple(fullTuple))
		return this
	}

	write(writes: WriteOps<S>): AsyncTupleRootTransactionApi<S> {
		this.checkActive()

		// If you're calling this function, then the order of these operations
		// shouldn't matter.
		const { set, remove } = writes
		for (const tuple of remove || []) {
			this.remove(tuple)
		}
		for (const { key, value } of set || []) {
			this.set(key, value)
		}
		return this
	}

	async commit() {
		this.checkActive()
		this.committed = true
		// TODO should just encode tuples to strings before passing to storage
		return this.db.commit(this.writes, this.id)
	}

	async cancel() {
		this.checkActive()
		this.canceled = true
		return this.db.cancel(this.id)
	}

	subspace<P extends TuplePrefix<S["key"]>>(
		prefix: P
	): AsyncTupleTransactionApi<RemoveTupleValuePairPrefix<S, P>> {
		this.checkActive()
		// TODO: types.
		return new AsyncTupleSubspaceTransaction(this as any, prefix)
	}
}

export class AsyncTupleSubspaceTransaction<S extends KeyValuePair>
	implements AsyncTupleTransactionApi<S>
{
	constructor(
		private tx: AsyncTupleTransactionApi<any>,
		public subspacePrefix: Tuple
	) {}

	async scan<T extends S["key"], P extends TuplePrefix<T>>(
		args: ScanArgs<T, P> = {}
	): Promise<FilterTupleValuePairByPrefix<S, P>[]> {
		const storageScanArgs = normalizeSubspaceScanArgs(this.subspacePrefix, args)
		const pairs = await this.tx.scan(storageScanArgs)
		const result = removePrefixFromTupleValuePairs(this.subspacePrefix, pairs)
		return result as FilterTupleValuePairByPrefix<S, P>[]
	}

	async get<T extends S["key"]>(
		tuple: T
	): Promise<ValueForTuple<S, T> | undefined> {
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)
		return this.tx.get(fullTuple)
	}

	async exists<T extends S["key"]>(tuple: T): Promise<boolean> {
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)
		return this.tx.exists(fullTuple)
	}

	// ReadApis
	set<T extends S>(
		tuple: T["key"],
		value: T["value"]
	): AsyncTupleTransactionApi<S> {
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)
		this.tx.set(fullTuple, value)
		return this
	}

	remove(tuple: S["key"]): AsyncTupleTransactionApi<S> {
		const fullTuple = prependPrefixToTuple(this.subspacePrefix, tuple)
		this.tx.remove(fullTuple)
		return this
	}

	write(writes: WriteOps<S>): AsyncTupleTransactionApi<S> {
		// If you're calling this function, then the order of these opertions
		// shouldn't matter.
		const { set, remove } = writes
		for (const tuple of remove || []) {
			this.remove(tuple)
		}
		for (const { key, value } of set || []) {
			this.set(key, value)
		}
		return this
	}

	subspace<P extends TuplePrefix<S["key"]>>(
		prefix: P
	): AsyncTupleTransactionApi<RemoveTupleValuePairPrefix<S, P>> {
		return new AsyncTupleSubspaceTransaction(this.tx, [
			...this.subspacePrefix,
			...prefix,
		])
	}
}
