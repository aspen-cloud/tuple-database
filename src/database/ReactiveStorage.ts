import { randomId } from "../helpers/randomId"
import { getBounds, Bounds, isWithinBounds } from "./indexHelpers"
import { InMemoryStorage, InMemoryTransaction } from "./InMemoryStorage"
import { MIN, ScanArgs, Storage, Tuple, Value, Writes } from "./types"

type Callback = (write: Writes) => void

export class ReactiveStorage implements Storage {
	constructor(private storage: Storage) {}

	private callbacks: { [id: string]: Callback } = {}
	private listeners = new InMemoryStorage()

	subscribe(index: string, args: ScanArgs, callack: Callback) {
		// Save the callback function for later.
		const id = randomId()
		this.callbacks[id] = callack

		// Track this callback on this prefix.
		const bounds = getBounds(args)
		const prefix = getScanPrefix(bounds)
		this.listeners.transact().set(index, [prefix, { id, bounds }]).commit()

		const unsubscribe = () => {
			delete this.callbacks[id]
			this.listeners.transact().remove(index, [prefix, { id, bounds }]).commit()
		}

		// Run the query.
		return [this.storage.scan(index, args), unsubscribe] as const
	}

	scan(index: string, args: ScanArgs = {}) {
		return this.storage.scan(index, args)
	}

	transact() {
		return new InMemoryTransaction({
			scan: (...args) => this.scan(...args),
			commit: (...args) => this.commit(...args),
		})
	}

	commit(writes: Writes) {
		const updates: { [callbackId: string]: Writes } = {}

		for (const [index, indexWrite] of Object.entries(writes)) {
			const setUpdates = this.fanout(index, indexWrite.sets)
			const removeUpdates = this.fanout(index, indexWrite.removes)
			for (const [callbackId, sets] of Object.entries(setUpdates)) {
				if (!updates[callbackId]) {
					updates[callbackId] = { [index]: { sets, removes: [] } }
				} else if (!updates[callbackId][index]) {
					updates[callbackId][index] = { sets, removes: [] }
				} else {
					updates[callbackId][index].sets.push(...sets)
				}
			}
			for (const [callbackId, removes] of Object.entries(removeUpdates)) {
				if (!updates[callbackId]) {
					updates[callbackId] = { [index]: { sets: [], removes } }
				} else if (!updates[callbackId][index]) {
					updates[callbackId][index] = { sets: [], removes }
				} else {
					updates[callbackId][index].removes.push(...removes)
				}
			}
		}

		this.storage.commit(writes)

		for (const [callbackId, write] of Object.entries(updates)) {
			this.callbacks[callbackId](write)
		}
	}

	private fanout(index: string, tuples: Array<Tuple>) {
		const updates: { [callbackId: string]: Array<Tuple> } = {}
		for (const tuple of tuples) {
			for (let i = 0; i < tuple.length; i++) {
				const prefix = tuple.slice(0, i)
				const results = this.listeners.scan(index, {
					gte: [prefix],
					lt: [[...prefix, MIN]],
				})
				for (const result of results) {
					const { id, bounds } = result[result.length - 1] as {
						id: string
						bounds: Bounds
					}
					if (isWithinBounds(tuple, bounds)) {
						if (!updates[id]) {
							updates[id] = [tuple]
						} else {
							updates[id].push(tuple)
						}
					} else {
						// TODO: track how in-efficient listeners are here.
					}
				}
			}
		}
		return updates
	}
}

function getScanPrefix(bounds: Bounds) {
	// Compute the common prefix.
	const prefix: Array<Value> = []
	const start = bounds.gt || bounds.gte || []
	const end = bounds.lt || bounds.lte || []
	const len = Math.min(start.length, end.length)
	for (let i = 0; i < len; i++) {
		if (start[i] === end[i]) {
			prefix.push(start[i])
		} else {
			break
		}
	}
	return prefix
}
