/**
 * Shared tokenizer for `{ }` interpolation. Tracks brace depth and string/comment
 * context so nested braces and content inside strings/comments are handled correctly.
 *
 * @remarks
 * Used by @aero-js/core (compileInterpolation, compileAttributeInterpolation) and
 * can be used by aero-vscode for consistent interpolation semantics.
 */

export type LiteralSegment = {
	kind: 'literal'
	start: number
	end: number
	value: string
}

export type InterpolationSegment = {
	kind: 'interpolation'
	start: number
	end: number
	expression: string
}

export type Segment = LiteralSegment | InterpolationSegment

/** Escape characters with special meaning inside generated template literals. */
export function escapeTemplateLiteralContent(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Remove outer braces: `"{ expr }"` → `expr`. */
export function stripBraces(s: string): string {
	const trimmed = s.trim()
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		return trimmed.slice(1, -1).trim()
	}
	return trimmed
}

/**
 * Tokenize a string into literal and interpolation segments. Tracks nesting and
 * string/comment context so expressions like `{ a({ b: 1 }) }` or `{ "}" }` are
 * one interpolation. Adjacent `{{` is nested JS (Svelte-style), not an escape.
 *
 * @param text - Input string (e.g. attribute value or text content).
 * @returns Array of segments in order.
 */
export function tokenizeCurlyInterpolation(text: string): Segment[] {
	const segments: Segment[] = []
	let i = 0
	let depth = 0
	let literalStart = 0
	/** Index of opening `{` for the current interpolation (for segment start/end span). */
	let interpOpenIndex = -1
	/** Start of expression (index after `{`) for slice. */
	let interpExprStart = -1
	let inString: null | '"' | "'" | '`' = null
	let inComment: null | '//' | '/*' = null

	function pushLiteral(from: number, to: number) {
		if (from < to) {
			segments.push({
				kind: 'literal',
				start: from,
				end: to,
				value: text.slice(from, to),
			})
		}
	}

	function pushInterpolation(openIndex: number, closeIndex: number) {
		// Segment spans the whole { ... } inclusive; end is exclusive (past the `}`).
		segments.push({
			kind: 'interpolation',
			start: openIndex,
			end: closeIndex + 1,
			expression: text.slice(openIndex + 1, closeIndex),
		})
	}

	while (i < text.length) {
		const char = text[i]
		const next = text[i + 1]

		if (inComment) {
			if (inComment === '//' && char === '\n') {
				inComment = null
			} else if (inComment === '/*' && char === '*' && next === '/') {
				inComment = null
				i++ // skip /
			}
			i++
			continue
		}

		if (inString) {
			if (char === '\\') {
				i++ // skip escaped char
			} else if (char === inString) {
				inString = null
			}
			i++
			continue
		}

		if (char === '/' && next === '/' && depth > 0) {
			inComment = '//'
			i += 2
			continue
		}
		if (char === '/' && next === '*' && depth > 0) {
			inComment = '/*'
			i += 2
			continue
		}
		if (depth > 0 && (char === '"' || char === "'" || char === '`')) {
			inString = char
			i++
			continue
		}

		if (char === '{') {
			if (depth === 0) {
				pushLiteral(literalStart, i)
				interpOpenIndex = i
				interpExprStart = i + 1
			}
			depth++
			i++
			continue
		}

		if (char === '}') {
			depth--
			if (depth === 0) {
				pushInterpolation(interpOpenIndex, i)
				literalStart = i + 1
			}
			i++
			continue
		}

		i++
	}

	// Unclosed interpolation at EOF: treat remainder as one interpolation expression
	if (depth > 0) {
		segments.push({
			kind: 'interpolation',
			start: interpOpenIndex,
			end: text.length,
			expression: text.slice(interpExprStart, text.length),
		})
		literalStart = text.length
	}

	pushLiteral(literalStart, text.length)
	return segments
}

/** Preserves `{` / `}` from numeric character references through HTML parse. */
export const BRACE_ENTITY_OPEN = '\uE003'
/** Preserves `}` from numeric character references through HTML parse. */
export const BRACE_ENTITY_CLOSE = '\uE004'

const BRACE_CHAR_REF_RE = /&#(?:x7[Bb]|x7[Dd]|123|125);/g

/** Replace `&#123;`-style references with placeholders so DOM parse does not start interpolation. */
export function encodeBraceCharacterReferences(text: string): string {
	return text.replace(BRACE_CHAR_REF_RE, ref => {
		const lower = ref.toLowerCase()
		return lower === '&#123;' || lower === '&#x7b;' ? BRACE_ENTITY_OPEN : BRACE_ENTITY_CLOSE
	})
}

/** Restore placeholder braces to literal `{` / `}` in compiled literal output. */
export function restoreLiteralBraces(value: string): string {
	return value.replaceAll(BRACE_ENTITY_OPEN, '{').replaceAll(BRACE_ENTITY_CLOSE, '}')
}

export type ByteRange = { readonly start: number; readonly end: number }

/** Ranges of Aero `{ ... }` expression interiors (exclusive of the brace characters). */
export function collectInterpolationBodyRanges(text: string): ByteRange[] {
	const ranges: ByteRange[] = []
	for (const seg of tokenizeCurlyInterpolation(text)) {
		if (seg.kind === 'interpolation') {
			ranges.push({ start: seg.start + 1, end: seg.end - 1 })
		}
	}
	return ranges
}

export function isOffsetInRanges(offset: number, ranges: readonly ByteRange[]): boolean {
	for (const range of ranges) {
		if (offset >= range.start && offset < range.end) return true
	}
	return false
}

/** Mask Aero `{ ... }` expression bodies so markup-like text inside is not parsed as HTML. */
export function maskInterpolationExpressionBodies(text: string): string {
	const chars = [...text]
	for (const seg of tokenizeCurlyInterpolation(text)) {
		if (seg.kind !== 'interpolation') continue
		for (let i = seg.start + 1; i < seg.end - 1; i++) {
			chars[i] = ' '
		}
	}
	return chars.join('')
}

const INTERPOLATION_BODY_LT_ESCAPE = '\uE000'
/** Preserves entity-encoded snippet tags through HTML parse; restored before text lowering. */
export const ENTITY_ENCODED_LT_ESCAPE = '\uE002'

/** Escape `&lt;tag…&gt;` so HTML parsers keep snippet markup as text, not real elements. */
export function escapeEntityEncodedElementMarkup(text: string): string {
	return text.replace(
		/&lt;(\/?)([A-Za-z][\w:-]*)([^&]*?)&gt;/g,
		(_match, slash: string, tagName: string, rest: string) =>
			`${ENTITY_ENCODED_LT_ESCAPE}${slash}${tagName}${rest}>`
	)
}

/** Restore text produced by {@link escapeEntityEncodedElementMarkup}. */
export function restoreEntityEncodedElementMarkup(value: string): string {
	return value.replaceAll(ENTITY_ENCODED_LT_ESCAPE, '<')
}

function maskScriptAndStyleInner(text: string): string {
	return text.replace(
		/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi,
		(match, _tag: string, inner: string) => match.replace(inner, ' '.repeat(inner.length))
	)
}

function collectScriptStyleInnerRanges(text: string): ByteRange[] {
	const ranges: ByteRange[] = []
	const re = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi
	let match: RegExpExecArray | null
	while ((match = re.exec(text)) !== null) {
		const tagName = match[1]!
		const closeTagLen = `</${tagName}>`.length
		const innerLen = match[2]!.length
		const start = match.index + match[0].length - closeTagLen - innerLen
		ranges.push({ start, end: start + innerLen })
	}
	return ranges
}

/** True when `<` at `index` begins HTML-like markup, not a comparison operator. */
function isMarkupLt(text: string, index: number): boolean {
	return /^[A-Za-z/!?]/.test(text.slice(index + 1))
}

/**
 * Escape `<` inside Aero `{ ... }` expression bodies so HTML parsers do not treat snippet
 * markup as real elements. Offsets are preserved; pair with {@link restoreInterpolationBodyMarkup}.
 */
export function escapeInterpolationBodyMarkup(text: string): {
	text: string
	restore: (value: string) => string
} {
	const maskedForTokenize = maskScriptAndStyleInner(text)
	const scriptStyleRanges = collectScriptStyleInnerRanges(text)
	const chars = [...text]
	for (const seg of tokenizeCurlyInterpolation(maskedForTokenize)) {
		if (seg.kind !== 'interpolation') continue
		for (let i = seg.start + 1; i < seg.end - 1; i++) {
			if (isOffsetInRanges(i, scriptStyleRanges)) continue
			if (chars[i] === '<' && isMarkupLt(text, i)) chars[i] = INTERPOLATION_BODY_LT_ESCAPE
		}
	}
	return {
		text: chars.join(''),
		restore: value => restoreInterpolationBodyMarkup(value),
	}
}

/** Restore text produced by {@link escapeInterpolationBodyMarkup}. */
export function restoreInterpolationBodyMarkup(value: string): string {
	return value
		.replaceAll(INTERPOLATION_BODY_LT_ESCAPE, '<')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
}

/**
 * Build a template-literal-safe string from segments: escape backticks in literal
 * segments and emit `${expression}` for interpolations.
 *
 * @param segments - Output from tokenizeCurlyInterpolation.
 * @returns String safe to embed inside a template literal (backticks).
 */
export function compileInterpolationFromSegments(segments: Segment[]): string {
	return segments
		.map(seg => {
			if (seg.kind === 'literal') {
				return escapeTemplateLiteralContent(seg.value)
			}
			return `\${${seg.expression}}`
		})
		.join('')
}
