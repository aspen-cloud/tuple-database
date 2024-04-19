import * as LMDB from "lmdb"
import { AsyncTupleStorageApi } from "../database/async/asyncTypes"
import {
	decodeTuple,
	decodeValue,
	encodeTuple,
	encodeValue,
} from "../helpers/codec"
import { KeyValuePair, MIN, ScanStorageArgs, WriteOps } from "./types"

export class LMDBTupleStorage implements AsyncTupleStorageApi {
	constructor(public db: LMDB.Database) {}

	async scan(args: ScanStorageArgs = {}): Promise<KeyValuePair[]> {
		const startTuple = args.gt ?? args.gte
		const start =
			startTuple !== undefined ? encodeTuple(startTuple) : encodeTuple([MIN])
		const endTuple = args.lt ?? args.lte
		const end = endTuple !== undefined ? encodeTuple(endTuple) : undefined
		if (start && end) {
			if (start > end) {
				throw new Error("invalid bounds for scan. Start is greater than end.")
			}
		}
		const results: KeyValuePair[] = []
		const reverse = args.reverse ?? false
		// console.log("scan args", args, start, end, reverse)
		for (const { key, value } of this.db.getRange({
			start: reverse ? end : start,
			reverse,
		})) {
			if (args.gt && (key as string) <= start!) {
				if (reverse) {
					break
				}
				continue
			}
			if (args.gte && (key as string) < start!) {
				if (reverse) {
					break
				}
				continue
			}
			if (args.lt && (key as string) >= end!) {
				if (reverse) {
					continue
				}
				break
			}
			if (args.lte && (key as string) > end!) {
				if (reverse) {
					continue
				}
				break
			}
			console.log(
				"scan",
				`key(${key as string})`,
				`value(${value})`,
				decodeTuple(key as string),
				decodeValue(value)
			)
			results.push({
				key: decodeTuple(key as string),
				value: decodeValue(value),
			})
			if (results.length >= (args?.limit ?? Infinity)) break
		}
		return results
	}

	async commit(writes: WriteOps): Promise<void> {
		await this.db.batch(() => {
			for (const tuple of writes.remove ?? []) {
				this.db.remove(encodeTuple(tuple))
			}
			for (const { key, value } of writes.set ?? []) {
				const storedKey = encodeTuple(key)
				const storedValue = encodeValue(value)
				this.db.put(storedKey, storedValue)
			}
		})
	}

	async close(): Promise<void> {
		return this.db.close()
	}
}
