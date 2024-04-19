import { describe, it, expect } from "bun:test"
import { Tuple } from "../storage/types"
import { sortedValues } from "../test/fixtures"
import { decodeTuple, decodeValue, encodeTuple, encodeValue } from "./codec"
import { compare } from "./compare"
import { TupleToString, ValueToString } from "./compareTuple"
import { randomInt } from "./random"

describe("codec", () => {
	describe("encodeValue", () => {
		it("Encodes and decodes properly", () => {
			for (let i = 0; i < sortedValues.length; i++) {
				const value = sortedValues[i]
				const encoded = encodeValue(value)
				const decoded = decodeValue(encoded)

				expect(decoded).toStrictEqual(value)
			}
		})

		it("Encodes in lexicographical order", () => {
			for (let i = 0; i < sortedValues.length; i++) {
				for (let j = 0; j < sortedValues.length; j++) {
					const a = encodeValue(sortedValues[i])
					const b = encodeValue(sortedValues[j])
					expect(compare(a, b)).toStrictEqual(compare(i, j))
				}
			}
		})
	})

	describe("encodeTuple", () => {
		it("Encodes and decodes properly", () => {
			const test = (tuple: Tuple) => {
				const encoded = encodeTuple(tuple)
				const decoded = decodeTuple(encoded)
				expect(decoded).toStrictEqual(tuple)
			}
			test([])
			for (let i = 0; i < sortedValues.length; i++) {
				const a = sortedValues[i]
				test([a])
				for (let j = 0; j < sortedValues.length; j++) {
					const b = sortedValues[j]
					test([a, b])
				}
			}

			for (let i = 0; i < sortedValues.length - 2; i++) {
				const opts = sortedValues.slice(i, i + 3)
				for (const a of opts) {
					for (const b of opts) {
						for (const c of opts) {
							test([a, b, c])
						}
					}
				}
			}
		})

		it("Encodes in lexicographical order", () => {
			const test = (aTuple: Tuple, bTuple: Tuple, result: number) => {
				const a = encodeTuple(aTuple)
				const b = encodeTuple(bTuple)
				expect(compare(a, b)).toStrictEqual(result)
			}

			for (let i = 0; i < sortedValues.length; i++) {
				for (let j = 0; j < sortedValues.length; j++) {
					const a = sortedValues[i]
					const b = sortedValues[j]
					test([a, a], [a, b], compare(i, j))
					test([a, b], [b, a], compare(i, j))
					test([b, a], [b, b], compare(i, j))
					if (i !== j) {
						test([a], [a, a], -1)
						test([a], [a, b], -1)
						test([a], [b, a], compare(i, j))
						test([a], [b, b], compare(i, j))
						test([b], [a, a], compare(j, i))
						test([b], [a, b], compare(j, i))
						test([b], [b, a], -1)
						test([b], [b, b], -1)
					}
				}
			}

			const sample = () => {
				const x = sortedValues.length
				const i = randomInt(x - 1)
				const j = randomInt(x - 1)
				const k = randomInt(x - 1)
				const tuple: Tuple = [sortedValues[i], sortedValues[j], sortedValues[k]]
				const rank = i * x * x + j * x + k
				return { tuple, rank }
			}

			// (40*40*40)^2 = 4 billion variations for these sorted 3-length tuples.
			for (let iter = 0; iter < 100_000; iter++) {
				const a = sample()
				const b = sample()
				test(a.tuple, b.tuple, compare(a.rank, b.rank))
			}
		})
	})
})
