import BTree from "sorted-btree"
import {
	KeyValuePair,
	MAX,
	MIN,
	ScanStorageArgs,
	Tuple,
	WriteOps,
} from "./types"
import { compareTuple } from "../helpers/compareTuple"
import { TupleStorageApi } from "../database/sync/types"

// Hack for https://github.com/qwertie/btree-typescript/issues/36
// @ts-ignore
const BTreeClass = (BTree.default ? BTree.default : BTree) as typeof BTree
export class MemoryBTreeStorage implements TupleStorageApi {
	btree: BTree<any, any>
	constructor() {
		this.btree = new BTreeClass<Tuple, any>(undefined, compareTuple)
	}
	scan(args?: ScanStorageArgs | undefined): KeyValuePair[] {
		const low = args?.gte ?? args?.gt ?? MIN
		const high = args?.lte ?? args?.lt ?? MAX
		const results: KeyValuePair[] = []
		// TODO use entries and entriesReversed instead?
		this.btree.forRange(low, high, args?.lte != null, (key, value, n) => {
			// if using gt (greater than) then skip equal keys
			if (args?.gt && compareTuple(key, args.gt) === 0) return
			results.push({ key, value })
			if (
				args?.reverse !== true &&
				results.length >= (args?.limit ?? Infinity)
			) {
				return { break: true }
			}
		})

		if (args?.reverse) results.reverse()
		if (args?.limit) return results.slice(0, args.limit)
		return results
	}
	commit(writes: WriteOps<KeyValuePair>): void {
		const { set, remove } = writes
		for (const tuple of remove || []) {
			this.btree.delete(tuple)
		}
		for (const { key, value } of set || []) {
			this.btree.set(key, value, true)
		}
	}
	close(): void {}

	wipe(): void {
		this.btree = new BTreeClass<Tuple, any>(undefined, compareTuple)
	}
}
