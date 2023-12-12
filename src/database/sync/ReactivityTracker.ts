/*

This file is generated from async/AsyncReactivityTracker.ts

*/

type Identity<T> = T

import { maybePromiseAll } from "../../helpers/maybeWaitForPromises"
import * as SortedTuple from "../../helpers/sortedTupleArray"
import { Bounds } from "../../helpers/sortedTupleArray"
import * as SortedTupleValue from "../../helpers/sortedTupleValuePairs"
import { ScanStorageArgs, WriteOps } from "../../storage/types"
import { TxId } from "../types"
import { Callback } from "./types"

type Listeners = Map<Callback, Bounds>

export class ReactivityTracker {
	private listeners: Listeners = new Map()

	subscribe(args: ScanStorageArgs, callback: Callback) {
		return subscribe(this.listeners, args, callback)
	}

	computeReactivityEmits(writes: WriteOps) {
		return getReactivityEmits(this.listeners, writes)
	}

	emit(emits: ReactivityEmits, txId: TxId) {
		let promises: any[] = []
		for (const [callback, writes] of emits.entries()) {
			try {
				// Catch sync callbacks.
				promises.push(callback(writes, txId))
			} catch (error) {
				console.error(error)
			}
		}
		// This trick allows us to return a Promise from a sync TupleDatabase#commit
		// when there are  callbacks. And this allows us to create an  client
		// on top of a sync client.
		return maybePromiseAll(promises)
	}
}

type ReactivityEmits = Map<Callback, Required<WriteOps>>

function getReactivityEmits(listenersDb: Listeners, writes: WriteOps) {
	const emits: ReactivityEmits = new Map()

	for (const [callback, bounds] of listenersDb) {
		const matchingWrites = SortedTupleValue.scan(writes.set || [], bounds)
		const matchingRemoves = SortedTuple.scan(writes.remove || [], bounds)
		if (matchingWrites.length > 0 || matchingRemoves.length > 0) {
			emits.set(callback, { set: matchingWrites, remove: matchingRemoves })
		}
	}

	return emits
}

function subscribe(
	listenersDb: Listeners,
	args: ScanStorageArgs,
	callback: Callback
) {
	listenersDb.set(callback, args)

	return () => {
		listenersDb.delete(callback)
	}
}
