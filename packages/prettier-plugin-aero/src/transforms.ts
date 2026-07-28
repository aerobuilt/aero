import type { Node } from '@aero-js/html-parser'
import { parseMinimalHtmlFromText, walkHtmlNodes } from '@aero-js/html-parser'
import { tokenizeCurlyInterpolation } from '@aero-js/interpolation'
import prettier from 'prettier'
import {
	formatAuthorAttributeName,
	isPrefixableAuthorAttribute,
	resolveAuthorAttributeForFormatting,
} from '@aero-js/compiler/author-attribute-format'
import {
	BUILD_DIRECTIVES,
	normalizeAttributeValue,
} from '@aero-js/compiler/build-directive-attributes'
import type { BuildDirectivePrefixMode } from '@aero-js/compiler/build-directive-attributes'
import {
	isSelfClosingComponentTag,
	quoteAttributeValue,
} from './directives.js'
import type { AeroPluginOptions } from './options.js'

type TextEdit = { start: number; end: number; text: string }

function collectAttributeEdits(
	source: string,
	nodes: Node[],
	prefixMode: BuildDirectivePrefixMode
): TextEdit[] {
	const edits: TextEdit[] = []
	for (const node of walkHtmlNodes(nodes)) {
		if (!node.attributes || !node.tag) continue
		const tagStart = node.start
		if (tagStart == null) continue

		for (const [name, rawValue] of Object.entries(node.attributes)) {
			const effectiveValue = rawValue ?? '""'
			if (
				!isPrefixableAuthorAttribute({
					tagName: node.tag,
					attrName: name,
					rawValue: effectiveValue,
				})
			) {
				continue
			}
			const canonical = resolveAuthorAttributeForFormatting(name)
			if (canonical == null) continue
			const desired = formatAuthorAttributeName(canonical, prefixMode)
			if (name === desired) continue

			const nameStart = findAttributeNameStart(source, tagStart, name, node.startTagEnd ?? undefined)
			if (nameStart == null) continue
			edits.push({ start: nameStart, end: nameStart + name.length, text: desired })
		}
	}
	return edits
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAttributeNameStart(
	source: string,
	tagStart: number,
	name: string,
	tagEnd?: number
): number | null {
	const openEnd =
		tagEnd ??
		(() => {
			const gt = source.indexOf('>', tagStart)
			return gt >= 0 ? gt + 1 : undefined
		})()
	const tagSlice =
		openEnd != null && openEnd > tagStart ? source.slice(tagStart, openEnd) : source.slice(tagStart)
	const escaped = escapeRegExp(name)
	const patterns = [
		new RegExp(`\\s${escaped}\\s*=`, 'i'),
		new RegExp(`\\s${escaped}(\\s|>|/>)`, 'i'),
		new RegExp(`^<[^>]*?\\s${escaped}\\s*=`, 'i'),
	]
	for (const pattern of patterns) {
		const match = tagSlice.match(pattern)
		if (match?.index != null) {
			const offset = match[0].search(new RegExp(escaped, 'i'))
			if (offset >= 0) return tagStart + match.index + offset
		}
	}
	const idx = tagSlice.indexOf(name)
	if (idx >= 0) {
		const before = tagSlice[idx - 1]
		const after = tagSlice[idx + name.length]
		if ((before === ' ' || before === '\n' || before === '\t' || idx === 0) && after !== '-') {
			return tagStart + idx
		}
	}
	return null
}

function formatBracedWrapper(inner: string, spaced: boolean): string {
	const trimmed = inner.trim()
	if (!trimmed) return spaced ? '{ }' : '{}'
	return spaced ? `{ ${trimmed} }` : `{${trimmed}}`
}

function isSingleBracedExpression(text: string): boolean {
	const trimmed = text.trim()
	const segments = tokenizeCurlyInterpolation(trimmed)
	return (
		segments.length === 1 &&
		segments[0].kind === 'interpolation' &&
		segments[0].start === 0 &&
		segments[0].end === trimmed.length
	)
}

/** Comma-separated idents / spreads / keyed props — Aero binding-list shape. */
function isSimpleBindingList(expr: string): boolean {
	return /^(?:\.\.\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:\s*:\s*[^,]+)?)\s*(?:,\s*(?:\.\.\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:\s*:\s*[^,]+)?)\s*)*$/.test(
		expr
	)
}

/**
 * Prettier parenthesizes comma-operator expressions (`a, b` → `(a, b)`).
 * Aero brace inners often use comma-separated binding lists (e.g. props),
 * which must not gain those parens.
 */
function stripSpuriousCommaOperatorParens(original: string, formatted: string): string {
	for (const candidate of [formatted, original]) {
		if (!candidate.startsWith('(') || !candidate.endsWith(')')) continue
		const inner = candidate.slice(1, -1).trim()
		if (inner.includes(',') && isSimpleBindingList(inner)) return inner
	}
	return formatted
}

async function formatExpressionContents(
	expression: string,
	options: prettier.Options,
	aeroSpaced?: boolean
): Promise<string> {
	const trimmed = expression.trim()
	const isBraceWrapped = /^\{[\s\S]*\}$/.test(trimmed)
	const formatOptions: prettier.Options = {
		...options,
		parser: 'babel-ts',
		semi: options.semi ?? false,
		// Nested `{…}` (object literals) follow aeroBracketSpacing so
		// `{{foo: 1}}` vs `{ { foo: 1 } }` stay consistent.
		...(isBraceWrapped && aeroSpaced !== undefined ? { bracketSpacing: aeroSpaced } : {}),
	}

	const stripFormatted = (value: string): string =>
		value
			.trim()
			.replace(/^;\s*/, '')
			.replace(/;\s*$/, '')

	const tryFormat = async (code: string): Promise<string | null> => {
		try {
			return stripFormatted(await prettier.format(code, formatOptions))
		} catch {
			return null
		}
	}

	const extractAssignmentRhs = (formatted: string): string =>
		formatted.replace(/^x\s*=\s*/, '').replace(/;$/, '').trim()

	// Brace-wrapped values: format as RHS so `{ foo: 1 }` is an object, not a labeled block.
	if (isBraceWrapped) {
		const assigned = await tryFormat(`x = ${trimmed}`)
		if (assigned != null) {
			return stripSpuriousCommaOperatorParens(trimmed, extractAssignmentRhs(assigned))
		}
	}

	const direct = await tryFormat(trimmed)
	if (direct != null) {
		if (isBraceWrapped && direct.includes('\n')) {
			const assigned = await tryFormat(`x = ${trimmed}`)
			if (assigned != null) {
				return stripSpuriousCommaOperatorParens(trimmed, extractAssignmentRhs(assigned))
			}
		}
		return stripSpuriousCommaOperatorParens(trimmed, direct)
	}

	try {
		const wrapped = await prettier.format(`(${trimmed})`, formatOptions)
		return stripFormatted(
			wrapped
				.trim()
				.replace(/^\(/, '')
				.replace(/\)\;?\s*$/, '')
		)
	} catch {
		return trimmed
	}
}

async function formatBracedRegion(
	source: string,
	start: number,
	end: number,
	spaced: boolean,
	options: prettier.Options,
	formatInner: boolean
): Promise<TextEdit | null> {
	const raw = source.slice(start, end)
	if (!isSingleBracedExpression(raw)) return null
	const inner = raw.trim().slice(1, -1)
	const formattedInner = formatInner
		? await formatExpressionContents(inner, options, spaced)
		: inner.trim()
	const next = formatBracedWrapper(formattedInner, spaced)
	if (next === raw) return null
	return { start, end, text: next }
}

async function collectBracketSpacingEdits(
	source: string,
	nodes: Node[],
	spaced: boolean,
	options: prettier.Options
): Promise<TextEdit[]> {
	const edits: TextEdit[] = []

	for (const node of walkHtmlNodes(nodes)) {
		if (node.tag === 'script' || node.tag === 'style') continue

		if (node.attributes) {
			for (const [name, rawValue] of Object.entries(node.attributes)) {
				if (rawValue == null) continue
				const value = normalizeAttributeValue(rawValue)
				const valueStart = findAttributeValueContentStart(
					source,
					node.start ?? 0,
					name,
					rawValue,
					node.startTagEnd ?? undefined
				)
				if (valueStart == null) continue
				const segments = tokenizeCurlyInterpolation(value)
				for (const seg of segments) {
					if (seg.kind !== 'interpolation') continue
					const edit = await formatBracedRegion(
						source,
						valueStart + seg.start,
						valueStart + seg.end,
						spaced,
						options,
						true
					)
					if (edit) edits.push(edit)
				}
			}
		}

		const innerStart = node.startTagEnd
		const innerEnd = node.endTagStart
		// Format braces in the raw inner source (not the DOM tree). The HTML parser may
		// invent element children inside template literals (e.g. `{ \`<slot />\` }`), and
		// mixed text+element content still has interpolations in the leading/trailing text.
		// Skipping when `children` has tags left those braces unformatted.
		if (innerStart != null && innerEnd != null && innerEnd > innerStart) {
			const text = source.slice(innerStart, innerEnd)
			const segments = tokenizeCurlyInterpolation(text)
			for (const seg of segments) {
				if (seg.kind !== 'interpolation') continue
				const edit = await formatBracedRegion(
					source,
					innerStart + seg.start,
					innerStart + seg.end,
					spaced,
					options,
					true
				)
				if (edit) edits.push(edit)
			}
		}
	}

	return edits
}

function findAttributeValueStart(
	source: string,
	tagStart: number,
	name: string,
	rawValue: string,
	tagEnd?: number
): number | null {
	const openEnd =
		tagEnd ??
		(() => {
			const gt = source.indexOf('>', tagStart)
			return gt >= 0 ? gt + 1 : undefined
		})()
	const tagSlice =
		openEnd != null && openEnd > tagStart ? source.slice(tagStart, openEnd) : source.slice(tagStart)
	const unquoted = normalizeAttributeValue(rawValue)
	const search = unquoted.startsWith('{')
		? unquoted
		: rawValue.startsWith('"') || rawValue.startsWith("'")
			? rawValue
			: `"${unquoted}"`
	const idx = tagSlice.indexOf(search)
	if (idx < 0) return null
	const eq = tagSlice.indexOf('=', tagSlice.indexOf(name))
	if (eq < 0 || eq > idx) return null
	return tagStart + idx
}

/** Start index of unwrapped attribute value content within source. */
function findAttributeValueContentStart(
	source: string,
	tagStart: number,
	name: string,
	rawValue: string,
	tagEnd?: number
): number | null {
	const valueStart = findAttributeValueStart(source, tagStart, name, rawValue, tagEnd)
	if (valueStart == null) return null
	const quote = source[valueStart]
	if (quote === '"' || quote === "'") return valueStart + 1
	return valueStart
}

function collectSelfClosingEdits(
	source: string,
	nodes: Node[],
	selfClosing: boolean
): TextEdit[] {
	const edits: TextEdit[] = []
	for (const node of walkHtmlNodes(nodes)) {
		if (!node.tag || !isSelfClosingComponentTag(node.tag)) continue
		const hasElementChildren = node.children?.some(child => Boolean(child.tag)) ?? false
		if (hasElementChildren) continue

		const start = node.start
		const end = node.end
		if (start == null || end == null) continue
		const original = source.slice(start, end)

		if (selfClosing) {
			if (/\/>\s*$/.test(original)) continue
			const openMatch = original.match(/^<([^\s/>]+)([^>]*)>\s*<\/\1>\s*$/s)
			if (!openMatch) continue
			const [, tag, attrs = ''] = openMatch
			edits.push({ start, end, text: `<${tag}${attrs} />` })
			continue
		}

		const selfMatch = original.match(/^<([^\s/>]+)([^>]*)\/\>\s*$/s)
		if (!selfMatch) continue
		const [, tag, attrs = ''] = selfMatch
		const trimmedAttrs = attrs.replace(/\s+$/, '')
		edits.push({ start, end, text: `<${tag}${trimmedAttrs}></${tag}>` })
	}
	return edits
}

function dedupeEdits(edits: TextEdit[]): TextEdit[] {
	const seen = new Set<string>()
	const unique: TextEdit[] = []
	for (const edit of edits) {
		const key = `${edit.start}:${edit.end}:${edit.text}`
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(edit)
	}
	return unique
}

function applyEdits(source: string, edits: TextEdit[]): string {
	if (edits.length === 0) return source
	const sorted = dedupeEdits(edits).sort((a, b) => b.start - a.start)
	let result = source
	for (const edit of sorted) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
	}
	return result
}

function parseRoots(source: string): Node[] {
	return parseMinimalHtmlFromText(source).roots
}

function getScriptOpenTag(source: string, node: Node): string | null {
	if (node.startTagEnd == null) return null
	const tagStart = source.lastIndexOf('<script', node.startTagEnd)
	if (tagStart === -1) return null
	return source.substring(tagStart, node.startTagEnd)
}

function isFormattableEmbeddedScript(node: Node): boolean {
	if (node.tag !== 'script' || node.attributes == null) return false
	return 'is:build' in node.attributes || 'is:state' in node.attributes
}

/** True if script has lang="ts" or lang="typescript". */
function hasLangTs(node: Node, source: string): boolean {
	const openTag = getScriptOpenTag(source, node)
	return openTag != null && /\blang\s*=\s*["'](ts|typescript)["']/i.test(openTag)
}

/** True if script opts into JavaScript with lang="js" or lang="javascript". */
function hasLangJs(node: Node, source: string): boolean {
	const openTag = getScriptOpenTag(source, node)
	return openTag != null && /\blang\s*=\s*["'](js|javascript)["']/i.test(openTag)
}

async function formatEmbeddedScriptBody(
	scriptContent: string,
	parser: 'babel-ts' | 'babel',
	options: prettier.Options
): Promise<string> {
	if (!scriptContent.trim()) return scriptContent

	const formatOptions: prettier.Options = {
		...options,
		parser,
		semi: options.semi ?? false,
	}

	try {
		const formatted = await prettier.format(scriptContent.trimEnd(), formatOptions)
		const leadingNewline = scriptContent.startsWith('\n') ? '\n' : ''
		const trailingNewline = scriptContent.endsWith('\n') ? '\n' : ''
		return leadingNewline + formatted.trimEnd() + trailingNewline
	} catch {
		return scriptContent
	}
}

async function collectEmbeddedScriptEdits(
	source: string,
	nodes: Node[],
	options: prettier.Options
): Promise<TextEdit[]> {
	const edits: TextEdit[] = []

	for (const node of walkHtmlNodes(nodes)) {
		if (!isFormattableEmbeddedScript(node)) continue
		if (node.startTagEnd == null || node.endTagStart == null) continue
		if (hasLangTs(node, source)) continue

		const scriptContent = source.substring(node.startTagEnd, node.endTagStart)
		if (!scriptContent.trim()) continue

		const parser = hasLangJs(node, source) ? 'babel' : 'babel-ts'
		const formatted = await formatEmbeddedScriptBody(scriptContent, parser, options)
		if (formatted !== scriptContent) {
			edits.push({ start: node.startTagEnd, end: node.endTagStart, text: formatted })
		}
	}

	return edits
}

export async function applyAeroTransforms(
	source: string,
	nodes: Node[],
	options: AeroPluginOptions,
	prettierOptions: prettier.Options = {}
): Promise<string> {
	let result = source
	let currentNodes = nodes

	const prefixEdits = collectAttributeEdits(result, currentNodes, options.aeroAttributePrefix)
	result = applyEdits(result, prefixEdits)
	currentNodes = parseRoots(result)

	const bracketEdits = await collectBracketSpacingEdits(
		result,
		currentNodes,
		options.aeroBracketSpacing,
		prettierOptions
	)
	result = applyEdits(result, bracketEdits)
	currentNodes = parseRoots(result)

	const selfClosingEdits = collectSelfClosingEdits(
		result,
		currentNodes,
		options.aeroSelfClosingComponents
	)
	result = applyEdits(result, selfClosingEdits)
	currentNodes = parseRoots(result)

	const embeddedScriptEdits = await collectEmbeddedScriptEdits(result, currentNodes, prettierOptions)
	result = applyEdits(result, embeddedScriptEdits)

	return result
}

export { quoteAttributeValue, BUILD_DIRECTIVES }
