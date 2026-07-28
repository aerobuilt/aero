import { describe, expect, it } from 'vitest'
import { tokenizeCurlyInterpolation } from '../index'

describe('text interpolation inside literal double quotes', () => {
	it('tokenizes { count } inside quoted HTML text', () => {
		const text = 'bind:count="{ count }"'
		const segments = tokenizeCurlyInterpolation(text)
		expect(segments).toEqual([
			{ kind: 'literal', start: 0, end: 12, value: 'bind:count="' },
			{ kind: 'interpolation', start: 12, end: 21, expression: ' count ' },
			{ kind: 'literal', start: 21, end: 22, value: '"' },
		])
	})
})
