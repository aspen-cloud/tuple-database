import { randomId } from "../helpers/randomId"
import {
	Bounds,
	isTupleWithinBounds,
	prefixTupleBounds,
} from "../helpers/sortedTupleArray"
import { InMemoryTupleStorage } from "./InMemoryTupleStorage"
import { TupleStorageApi } from "./sync/types"
import { Callback, MIN, ScanStorageArgs, Tuple, Writes } from "./types"

export class ReactivityTracker {
	private listenersDb = new InMemoryTupleStorage()

	subscribe(args: ScanStorageArgs, callback: Callback) {
		return subscribe(this.listenersDb, args, callback)
	}

	computeReactivityEmits(writes: Writes) {
		return getReactivityEmits(this.listenersDb, writes)
	}

	emit(emits: ReactivityEmits) {
		for (const [callback, writes] of emits.entries()) {
			callback(writes)
		}
	}
}

type Listener = { callback: Callback; bounds: Bounds }

function iterateTuplePrefixes(tuple: Tuple) {
	const prefixes: Tuple[] = []
	for (let i = 0; i < tuple.length; i++) {
		const prefix = tuple.slice(0, i)
		prefixes.push(prefix)
	}
	return prefixes
}

/** Query the listenersDb based on tuple prefixes. */
function getListenersForTuplePrefix(
	listenersDb: TupleStorageApi,
	tuple: Tuple
) {
	const listeners: Listener[] = []

	// Look for listeners at each prefix of the tuple.
	for (const prefix of iterateTuplePrefixes(tuple)) {
		const results = listenersDb.scan({
			gte: [prefix],
			lt: [[...prefix, MIN]],
		})

		for (const [_prefix, value] of results) {
			listeners.push(value)
		}
	}

	return listeners
}

/** Query the listenersDb based on tuple prefixes, and additionally check for query bounds. */
function getListenerCallbacksForTuple(
	listenersDb: TupleStorageApi,
	tuple: Tuple
) {
	const callbacks: Callback[] = []

	// Check that the tuple is within the absolute bounds of the query.
	for (const listener of getListenersForTuplePrefix(listenersDb, tuple)) {
		const { callback, bounds } = listener
		if (isTupleWithinBounds(tuple, bounds)) {
			callbacks.push(callback)
		} else {
			// TODO: track how in-efficient listeners are here.
			// NOTE: the bounds may only partially span the prefix.
		}
	}

	return callbacks
}

type ReactivityEmits = Map<Callback, Required<Writes>>

function getReactivityEmits(listenersDb: TupleStorageApi, writes: Writes) {
	const emits: ReactivityEmits = new Map()

	for (const [tuple, value] of writes.set || []) {
		const callbacks = getListenerCallbacksForTuple(listenersDb, tuple)
		for (const callback of callbacks) {
			if (!emits.has(callback)) emits.set(callback, { set: [], remove: [] })
			emits.get(callback)!.set.push([tuple, value])
		}
	}

	for (const tuple of writes.remove || []) {
		const callbacks = getListenerCallbacksForTuple(listenersDb, tuple)
		for (const callback of callbacks) {
			if (!emits.has(callback)) emits.set(callback, { set: [], remove: [] })
			emits.get(callback)!.remove.push(tuple)
		}
	}

	return emits
}

function subscribe(
	listenersDb: TupleStorageApi,
	args: ScanStorageArgs,
	callback: Callback
) {
	// this.log("db/subscribe", args)

	const prefix = prefixTupleBounds(args)

	const id = randomId()
	const value: Listener = { callback, bounds: args }

	listenersDb.commit({ set: [[[prefix, id], value]] })

	const unsubscribe = () => {
		// this.log("db/unsubscribe", args)
		listenersDb.commit({ remove: [[prefix, id]] })
	}

	return unsubscribe
}
