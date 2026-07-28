/**
 * Unit tests for @aero-js/interpolation: tokenizeCurlyInterpolation and compileInterpolationFromSegments.
 *
 * Covers: nested braces, strings containing } or ", comments containing braces,
 * adjacent `{{` as nested JS (Svelte-style), and segment→compiled string output.
 */

import { describe, it, expect } from 'vitest'
import {
	tokenizeCurlyInterpolation,
	compileInterpolationFromSegments,
	type Segment,
} from '../index'

describe('tokenizeCurlyInterpolation', () => {
	it('returns single literal segment for string with no braces', () => {
		const segments = tokenizeCurlyInterpolation('hello world')
		expect(segments).toEqual([{ kind: 'literal', start: 0, end: 11, value: 'hello world' }])
	})

	it('parses simple interpolation', () => {
		const segments = tokenizeCurlyInterpolation('hello {name}')
		expect(segments).toEqual([
			{ kind: 'literal', start: 0, end: 6, value: 'hello ' },
			{ kind: 'interpolation', start: 6, end: 12, expression: 'name' },
		])
	})

	it('parses nested braces as single interpolation', () => {
		const input = '{ a({ b: 1 }) }'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0]).toEqual({
			kind: 'interpolation',
			start: 0,
			end: input.length,
			expression: ' a({ b: 1 }) ',
		})
	})

	it('treats adjacent {{ as nested JS (object / block expression)', () => {
		const input = '{{ literal }}'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0]).toEqual({
			kind: 'interpolation',
			start: 0,
			end: input.length,
			expression: '{ literal }',
		})
		expect(compileInterpolationFromSegments(segments)).toBe('${{ literal }}')
	})

	it('treats {{ {expr} }} as nested interpolation expression', () => {
		const input = '{{ {expr} }}'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
		expect((segments[0] as { expression: string }).expression).toBe('{ {expr} }')
	})

	it('string containing } does not end interpolation', () => {
		const input = '{ "}" }'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
		expect((segments[0] as { expression: string }).expression).toContain('"}"')
	})

	it('string containing double quote', () => {
		const input = "{ '\"' }"
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
		expect((segments[0] as { expression: string }).expression.trim()).toContain("'\"'")
	})

	it('comment containing braces does not end interpolation', () => {
		const input = '{ a /* } */ }'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
		expect((segments[0] as { expression: string }).expression).toContain('a /* } */')
	})

	it('line comment containing }', () => {
		const input = '{ x // }\n }'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
	})

	it('multiple interpolations', () => {
		const segments = tokenizeCurlyInterpolation('{a} and {b}')
		expect(segments).toEqual([
			{ kind: 'interpolation', start: 0, end: 3, expression: 'a' },
			{ kind: 'literal', start: 3, end: 8, value: ' and ' },
			{ kind: 'interpolation', start: 8, end: 11, expression: 'b' },
		])
	})

	it('backslash escape in double-quoted string', () => {
		const input = '{ "\\" }'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
	})

	it('unclosed {{ at EOF is one interpolation', () => {
		const input = '{{'
		const segments = tokenizeCurlyInterpolation(input)
		expect(segments).toHaveLength(1)
		expect(segments[0].kind).toBe('interpolation')
		expect((segments[0] as { expression: string }).expression).toBe('{')
	})
})

describe('compileInterpolationFromSegments', () => {
	it('literals only → unchanged (no backticks)', () => {
		const segments: Segment[] = [{ kind: 'literal', start: 0, end: 5, value: 'hello' }]
		expect(compileInterpolationFromSegments(segments)).toBe('hello')
	})

	it('escapes backticks in literal segments', () => {
		const segments: Segment[] = [{ kind: 'literal', start: 0, end: 7, value: '`world`' }]
		expect(compileInterpolationFromSegments(segments)).toBe('\\`world\\`')
	})

	it('escapes backslashes and literal ${ sequences in literal segments', () => {
		const segments: Segment[] = [{ kind: 'literal', start: 0, end: 15, value: 'path \\ ${value}' }]
		expect(compileInterpolationFromSegments(segments)).toBe('path \\\\ \\${value}')
	})

	it('interpolation segment → ${expression}', () => {
		const segments: Segment[] = [{ kind: 'interpolation', start: 0, end: 6, expression: 'name' }]
		expect(compileInterpolationFromSegments(segments)).toBe('${name}')
	})

	it('mixed literal and interpolation', () => {
		const segments: Segment[] = [
			{ kind: 'literal', start: 0, end: 6, value: 'hello ' },
			{ kind: 'interpolation', start: 6, end: 12, expression: 'name' },
		]
		expect(compileInterpolationFromSegments(segments)).toBe('hello ${name}')
	})
})
