/**
 * Position classification: what the cursor is on in an Aero HTML document (import path, component tag, content global, etc.).
 *
 * @remarks
 * Used by definition, hover, and completion providers to decide what to resolve or suggest. classifyPosition runs the detection pipeline (imports, assets, component tags, expression identifiers).
 */
import * as vscode from 'vscode'
import { analyzeBuildScriptForEditor } from '@aero-js/compiler/build-script-analysis'
import { COMPONENT_SUFFIX_REGEX, CONTENT_GLOBALS } from './constants'
import { type Node, parseAeroHtmlDocument } from '@aero-js/html-parser'
import { parseScriptBlocks } from './script-tag'

/** Result of classifying a position: kind-specific data and range, or null. */
export type PositionKind =
	| { kind: 'import-path'; specifier: string; range: vscode.Range }
	| {
			kind: 'import-name'
			name: string
			specifier: string
			range: vscode.Range
	  }
	| { kind: 'script-src'; value: string; range: vscode.Range }
	| { kind: 'link-href'; value: string; range: vscode.Range }
	| {
			kind: 'component-tag'
			tagName: string
			baseName: string
			suffix: 'component' | 'layout'
			range: vscode.Range
	  }
	| {
			kind: 'content-global'
			identifier: string
			alias: string
			propertyPath: string[]
			range: vscode.Range
	  }
	| { kind: 'expression-identifier'; identifier: string; range: vscode.Range }

/**
 * Classify what the cursor is on at the given position in an HTML document.
 *
 * @param document - The HTML text document.
 * @param position - Cursor position.
 * @returns PositionKind descriptor or null if nothing Aero-specific.
 */
export function classifyPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): PositionKind | null {
	// 1. Check for import path or imported name (AST-based via compiler)
	const importResult = getImportAt(document, position)
	if (importResult) return importResult

	// 2. Check for <script src="..."> or <link href="..."> (HTML parser — supports multiline tags)
	const assetResult = getAssetRefAt(document, position)
	if (assetResult) return assetResult

	// 3. Check for component/layout tag name
	const tagResult = getComponentTagAt(document, position)
	if (tagResult) return tagResult

	// 4. Check for content globals / identifiers in { } expressions
	const exprResult = getExpressionIdentifierAt(document, position)
	if (exprResult) return exprResult
	return null
}

// ---------------------------------------------------------------------------
// Import path / imported name detection (AST-based via compiler)
// ---------------------------------------------------------------------------

function getImportAt(
	document: vscode.TextDocument,
	position: vscode.Position
): PositionKind | null {
	const text = document.getText()
	const offset = document.offsetAt(position)
	const blocks = parseScriptBlocks(text).filter(b => b.kind !== 'external')

	for (const block of blocks) {
		const contentEnd = block.contentStart + block.content.length
		if (offset < block.contentStart || offset > contentEnd) continue
		const content = block.content
		const contentStart = block.contentStart

		try {
			const { imports: editorImports } = analyzeBuildScriptForEditor(content)
			for (const imp of editorImports) {
				const [specStart, specEnd] = imp.specifierRange
				const absSpecStart = contentStart + specStart
				const absSpecEnd = contentStart + specEnd
				if (offset >= absSpecStart && offset <= absSpecEnd) {
					return {
						kind: 'import-path',
						specifier: imp.specifier,
						range: new vscode.Range(
							document.positionAt(absSpecStart),
							document.positionAt(absSpecEnd)
						),
					}
				}
				const bindingRanges = imp.bindingRanges ?? {}
				for (const [name, range] of Object.entries(bindingRanges)) {
					const [r0, r1] = range as [number, number]
					const absStart = contentStart + r0
					const absEnd = contentStart + r1
					if (offset >= absStart && offset <= absEnd) {
						return {
							kind: 'import-name',
							name,
							specifier: imp.specifier,
							range: new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd)),
						}
					}
				}
			}
		} catch {
			// Parse error; skip
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Asset reference detection (<script src>, <link href>)
// ---------------------------------------------------------------------------

function attributeValueAtOffset(
	sourceText: string,
	node: Node,
	offset: number,
	attrName: string
): { start: number; end: number; value: string } | null {
	if (node.startTagEnd == null) return null
	const open = sourceText.slice(node.start, node.startTagEnd)
	const re = new RegExp(`\\b${attrName}\\s*=\\s*(['"])(.*?)\\1`, 'gis')
	let m: RegExpExecArray | null
	while ((m = re.exec(open)) !== null) {
		const val = m[2]
		const quote = m[1]
		const valStartInMatch = m[0].indexOf(quote + val + quote) + 1
		const valStart = node.start + m.index + valStartInMatch
		const valEnd = valStart + val.length
		if (offset >= valStart && offset <= valEnd) {
			return { start: valStart, end: valEnd, value: val }
		}
	}
	return null
}

function getAssetRefAt(
	document: vscode.TextDocument,
	position: vscode.Position
): PositionKind | null {
	const offset = document.offsetAt(position)
	const text = document.getText()
	const uri = document.uri.toString()
	const htmlDoc = parseAeroHtmlDocument(text, uri)
	const node = htmlDoc.findNodeAt(offset)
	if (!node?.tag || node.startTagEnd == null) return null

	const tag = node.tag.toLowerCase()
	if (tag === 'script') {
		const r = attributeValueAtOffset(text, node, offset, 'src')
		if (r) {
			return {
				kind: 'script-src',
				value: r.value,
				range: new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)),
			}
		}
	}
	if (tag === 'link') {
		const r = attributeValueAtOffset(text, node, offset, 'href')
		if (r) {
			return {
				kind: 'link-href',
				value: r.value,
				range: new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)),
			}
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Component/layout tag detection
// ---------------------------------------------------------------------------

function getComponentTagAt(
	document: vscode.TextDocument,
	position: vscode.Position
): PositionKind | null {
	const offset = document.offsetAt(position)
	const text = document.getText()
	const uri = document.uri.toString()
	const htmlDoc = parseAeroHtmlDocument(text, uri)
	const node = htmlDoc.findNodeAt(offset)
	if (!node?.tag || node.startTagEnd == null) return null

	const tl = node.tag.toLowerCase()
	if (tl === 'script' || tl === 'style') return null

	const open = text.slice(node.start, node.startTagEnd)
	const nameMatch = open.match(/^<\s*\/?\s*([a-zA-Z][\w-]*)/)
	if (!nameMatch) return null
	const tagName = nameMatch[1]
	const suffixMatch = COMPONENT_SUFFIX_REGEX.exec(tagName)
	if (!suffixMatch) return null

	const nameStartInOpen = nameMatch.index! + nameMatch[0].length - tagName.length
	const nameAbsStart = node.start + nameStartInOpen
	const nameAbsEnd = nameAbsStart + tagName.length
	if (offset < nameAbsStart || offset > nameAbsEnd) return null

	const suffix = suffixMatch[1] as 'component' | 'layout'
	const baseName = tagName.replace(COMPONENT_SUFFIX_REGEX, '')
	return {
		kind: 'component-tag',
		tagName,
		baseName,
		suffix,
		range: new vscode.Range(document.positionAt(nameAbsStart), document.positionAt(nameAbsEnd)),
	}
}

// ---------------------------------------------------------------------------
// Expression identifier detection (with dot-chain support)
// ---------------------------------------------------------------------------

/**
 * Detect whether the cursor is on a known content global (like `site`) or on
 * a dot-chain rooted at a content global (like `site.home.title`) inside a
 * `{ ... }` expression.
 *
 * For `{ site.home.title }` with cursor on any of `site`, `home`, or `title`:
 * - Returns kind 'content-global' with the full dot-chain parsed
 * - propertyPath contains the segments after the root (e.g. ['home', 'title'])
 * - range covers the portion from the root through the segment under cursor
 */
function getExpressionIdentifierAt(
	document: vscode.TextDocument,
	position: vscode.Position
): PositionKind | null {
	const lineText = document.lineAt(position.line).text
	const offset = position.character

	const expressionRange = getExpressionContextRangeAt(document, position, lineText, offset)
	if (!expressionRange) {
		return null
	}

	// Find the full dot-chain at/around the cursor position.
	// A dot-chain is something like `site.home.title` -- identifiers joined by dots.
	const chain = getDotChainAtPosition(lineText, offset)
	if (!chain) return null
	const chainEnd = chain.start + chain.text.length
	if (chain.start < expressionRange.start || chainEnd > expressionRange.end) {
		return null
	}

	// Parse the chain into segments
	const segments = chain.text.split('.')
	const rootIdentifier = segments[0]

	// Check if the root is a known content global
	if (rootIdentifier in CONTENT_GLOBALS) {
		// Determine which segment the cursor is on, and build the propertyPath
		// up to that segment for targeted navigation
		const cursorOffsetInChain = offset - chain.start
		let runningOffset = 0
		let cursorSegmentIndex = 0

		for (let i = 0; i < segments.length; i++) {
			const segEnd = runningOffset + segments[i].length
			if (cursorOffsetInChain <= segEnd) {
				cursorSegmentIndex = i
				break
			}
			runningOffset = segEnd + 1 // +1 for the dot
		}

		// propertyPath = segments after root, up to and including the cursor segment
		const propertyPath = segments.slice(1, cursorSegmentIndex + 1)

		// The range covers from the root through the segment under cursor
		// so option+hover underlines a meaningful chunk
		let rangeEnd = chain.start
		for (let i = 0; i <= cursorSegmentIndex; i++) {
			rangeEnd += segments[i].length
			if (i < cursorSegmentIndex) rangeEnd += 1 // dot
		}

		return {
			kind: 'content-global',
			identifier: rootIdentifier,
			alias: CONTENT_GLOBALS[rootIdentifier],
			propertyPath,
			range: new vscode.Range(position.line, chain.start, position.line, rangeEnd),
		}
	}

	// Not a content global -- return as generic expression identifier.
	// Use the chain root as the identifier so that a cursor on `site` inside
	// `Aero.site.url` resolves as `Aero` (the chain root), not the bare word
	// `site` which might shadow an unrelated import or variable.
	const wordRange = getWordRangeAtPosition(lineText, position.line, offset)
	if (!wordRange) return null

	const identifier =
		segments.length > 1
			? rootIdentifier
			: lineText.slice(wordRange.start.character, wordRange.end.character)

	return {
		kind: 'expression-identifier',
		identifier,
		range: wordRange,
	}
}

/**
 * Returns the active expression context around the cursor:
 * - `{ ... }` interpolation expressions
 * - expression-valued Aero attributes like `if="{ props.showLogo }"`
 */
function getExpressionContextRangeAt(
	document: vscode.TextDocument,
	position: vscode.Position,
	lineText: string,
	offset: number
): { start: number; end: number } | null {
	if (isInsideInlineScript(document, position)) {
		return { start: 0, end: lineText.length }
	}

	if (isInsideCurlyExpression(lineText, offset)) {
		return { start: 0, end: lineText.length }
	}

	const attrRange = getAeroExpressionAttributeValueRangeAt(lineText, offset)
	if (attrRange) return attrRange

	return null
}

/**
 * Check whether the cursor is inside the content of an inline <script> block.
 */
function isInsideInlineScript(document: vscode.TextDocument, position: vscode.Position): boolean {
	const text = document.getText()
	const offset = document.offsetAt(position)
	const blocks = parseScriptBlocks(text).filter(b => b.kind !== 'external')

	for (const block of blocks) {
		const contentEnd = block.contentStart + block.content.length
		if (offset >= block.contentStart && offset <= contentEnd) {
			return true
		}
	}

	return false
}

/**
 * Check whether the cursor is inside an Aero expression attribute value.
 * Supports: build directives (if/else-if/for) and event directives (on:* forms).
 */
function getAeroExpressionAttributeValueRangeAt(
	lineText: string,
	offset: number
): { start: number; end: number } | null {
	const attrValueRegex =
		/\b(?:data-aero-|aero-)?(?:if|else-if|for|on[:\-][a-z0-9_.:-]+)\s*=\s*(['"])(.*?)\1/gi

	let match: RegExpExecArray | null
	while ((match = attrValueRegex.exec(lineText)) !== null) {
		const value = match[2]
		const valueStart = match.index + match[0].lastIndexOf(match[1] + value + match[1]) + 1
		const openBraceOffset = value.indexOf('{')
		const closeBraceOffset = value.lastIndexOf('}')

		if (openBraceOffset === -1 || closeBraceOffset === -1 || closeBraceOffset <= openBraceOffset) {
			continue
		}

		const exprStart = valueStart + openBraceOffset + 1
		const exprEnd = valueStart + closeBraceOffset
		if (offset >= exprStart && offset <= exprEnd) {
			return { start: exprStart, end: exprEnd }
		}
	}

	return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if offset is inside a { ... } expression by counting unmatched braces
 * walking backwards from the offset.
 */
function isInsideCurlyExpression(lineText: string, offset: number): boolean {
	let braceDepth = 0
	for (let i = offset - 1; i >= 0; i--) {
		const ch = lineText[i]
		if (ch === '}') braceDepth++
		if (ch === '{') {
			if (braceDepth === 0) return true
			braceDepth--
		}
	}
	return false
}

/**
 * Find the full dot-chain (e.g. `site.home.title`) at the given offset.
 * Returns the text and start position, or null.
 */
function getDotChainAtPosition(
	lineText: string,
	offset: number
): { text: string; start: number } | null {
	// First, verify the cursor is on an identifier or dot character
	const ch = lineText[offset]
	const prevCh = offset > 0 ? lineText[offset - 1] : ''
	if (!isIdentChar(ch) && ch !== '.' && !isIdentChar(prevCh)) {
		return null
	}

	// Expand left from offset to find the start of the dot-chain
	let start = offset
	while (start > 0) {
		const c = lineText[start - 1]
		if (isIdentChar(c) || c === '.') {
			start--
		} else {
			break
		}
	}

	// Expand right from offset to find the end of the dot-chain
	let end = offset
	while (end < lineText.length) {
		const c = lineText[end]
		if (isIdentChar(c) || c === '.') {
			end++
		} else {
			break
		}
	}

	const text = lineText.slice(start, end)

	// Trim leading/trailing dots (shouldn't happen but be safe)
	const trimmed = text.replace(/^\.+|\.+$/g, '')
	if (!trimmed || (!trimmed.includes('.') && !isIdentStart(trimmed[0]))) {
		// Single word with no dots -- fall through to simple word matching
		if (trimmed && isIdentStart(trimmed[0])) {
			const trimStart = start + text.indexOf(trimmed)
			return { text: trimmed, start: trimStart }
		}
		return null
	}

	const trimStart = start + text.indexOf(trimmed)
	return { text: trimmed, start: trimStart }
}

function isIdentChar(ch: string | undefined): boolean {
	if (!ch) return false
	return /[a-zA-Z0-9_$]/.test(ch)
}

function isIdentStart(ch: string | undefined): boolean {
	if (!ch) return false
	return /[a-zA-Z_$]/.test(ch)
}

function getWordRangeAtPosition(
	lineText: string,
	lineNum: number,
	offset: number
): vscode.Range | null {
	const identRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g
	let match: RegExpExecArray | null
	while ((match = identRegex.exec(lineText)) !== null) {
		const start = match.index
		const end = start + match[0].length
		if (offset >= start && offset <= end) {
			return new vscode.Range(lineNum, start, lineNum, end)
		}
	}
	return null
}
