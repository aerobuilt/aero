import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const grammarPath = path.join(import.meta.dirname, '..', '..', 'syntaxes', 'aero-expressions.json')
const htmlGrammarPath =
	'/Applications/Cursor.app/Contents/Resources/app/extensions/html/syntaxes/html.tmLanguage.json'
const tsGrammarPath =
	'/Applications/Cursor.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json'

describe('aero-expressions grammar', () => {
	const grammar = JSON.parse(readFileSync(grammarPath, 'utf8')) as {
		injectionSelector: string
		patterns: Array<{
			name?: string
			contentName?: string
			beginCaptures?: Record<string, { name?: string }>
			endCaptures?: Record<string, { name?: string }>
		}>
	}

	it('wraps braced expressions in meta.embedded.block for tokenTypes reset', () => {
		const rule = grammar.patterns[0]
		expect(rule.name).toBe('meta.embedded.block.expression.aero')
		expect(rule.contentName).toBe('meta.embedded.expression.aero source.ts')
	})

	it('uses string delimiter scopes on braces so themes color them like quotes', () => {
		const rule = grammar.patterns[0]
		expect(rule.beginCaptures?.['1']?.name).toContain('punctuation.definition.string.begin.html')
		expect(rule.endCaptures?.['1']?.name).toContain('punctuation.definition.string.end.html')
	})

	it('injects with right priority over html string rules', () => {
		expect(grammar.injectionSelector).toMatch(/^R:/)
		expect(grammar.injectionSelector).not.toContain('L:')
		expect(grammar.injectionSelector).toContain('text.html.basic')
		expect(grammar.injectionSelector).not.toContain('text.html.aero')
	})
})

function scopesAt(
	line: string,
	index: number,
	tokens: Array<{ startIndex: number; endIndex: number; scopes: string[] }>
): string[] {
	const token = tokens.find(t => t.startIndex <= index && index < t.endIndex)
	return token?.scopes ?? []
}

describe.skipIf(!existsSync(htmlGrammarPath))('aero-expressions tokenization', () => {
	async function tokenize(line: string) {
		const { Registry, parseRawGrammar, INITIAL } = require('vscode-textmate')
		const { loadWASM, createOnigScanner, createOnigString } = require('vscode-oniguruma')

		const pkgDir = path.dirname(require.resolve('vscode-oniguruma/package.json'))
		await loadWASM(readFileSync(path.join(pkgDir, 'release/onig.wasm')).buffer)

		const onigLib = { createOnigScanner, createOnigString }
		const expressionsGrammar = parseRawGrammar(readFileSync(grammarPath, 'utf8'), grammarPath)

		const reg = new Registry({
			onigLib: Promise.resolve(onigLib),
			loadGrammar: async (scope: string) => {
				if (scope === 'text.html.basic') {
					return parseRawGrammar(readFileSync(htmlGrammarPath, 'utf8'), htmlGrammarPath)
				}
				if (scope === 'aero.expressions.injection') return expressionsGrammar
				if (scope === 'source.ts' && existsSync(tsGrammarPath)) {
					return parseRawGrammar(readFileSync(tsGrammarPath, 'utf8'), tsGrammarPath)
				}
				return null
			},
			getInjections: (scopeName: string) =>
				scopeName.includes('string.quoted') || scopeName === 'text.html.basic'
					? ['aero.expressions.injection']
					: [],
		})

		const g = await reg.loadGrammar('text.html.basic')
		const result = g!.tokenizeLine(line, INITIAL)
		return result.tokens as Array<{ startIndex: number; endIndex: number; scopes: string[] }>
	}

	function expectOuterAeroBraces(
		line: string,
		tokens: Awaited<ReturnType<typeof tokenize>>
	) {
		const openIdx = line.indexOf('{')
		const closeIdx = line.lastIndexOf('}')
		expect(
			scopesAt(line, openIdx, tokens).some(s =>
				s.includes('punctuation.section.embedded.begin.aero')
			)
		).toBe(true)
		expect(
			scopesAt(line, closeIdx, tokens).some(s =>
				s.includes('punctuation.section.embedded.end.aero')
			)
		).toBe(true)
	}

	it('scopes outer braces of { foo } like Aero interpolations', async () => {
		const line = `<div title="{ foo }"></div>`
		const tokens = await tokenize(line)
		expectOuterAeroBraces(line, tokens)
	})

	it('scopes outer braces of { { foo: 1 } } like single-brace interpolations', async () => {
		const line = `<div data-example="{ { foo: 1 } }"></div>`
		const tokens = await tokenize(line)
		expectOuterAeroBraces(line, tokens)
		const innerOpen = line.indexOf('{', line.indexOf('{') + 1)
		expect(
			scopesAt(line, innerOpen, tokens).some(s =>
				s.includes('punctuation.section.embedded.begin.aero')
			)
		).toBe(false)
	})

	it('scopes outer braces of {{ foo: 1 }} like single-brace interpolations', async () => {
		const line = `<div data-example="{{ foo: 1 }}"></div>`
		const tokens = await tokenize(line)
		expectOuterAeroBraces(line, tokens)
	})
})
