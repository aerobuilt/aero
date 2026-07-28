/**
 * Shared utilities: kebab-case conversion, import extraction, and scope lookup.
 */
import { analyzeBuildScriptForEditor } from '@aero-js/compiler/build-script-analysis'
import { collectInterpolationBodyRanges } from '@aero-js/interpolation'
import type { TemplateScope } from './analyzer'
import { parseScriptBlocks } from './script-tag'

/** Matches HTML comment blocks. */
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g

export type IgnoredRange = { start: number; end: number }

/** Convert kebab-case to camelCase (e.g. `my-component` → `myComponent`). */
export function kebabToCamelCase(value: string): string {
	return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

/**
 * Extract all imported names and their specifiers from an HTML document by
 * parsing each <script is:build> block and merging results. Use this when
 * you have the full document text (e.g. diagnostics, definition provider).
 */
export function collectImportedSpecifiersFromDocument(documentText: string): Map<string, string> {
	const merged = new Map<string, string>()
	const buildBlocks = parseScriptBlocks(documentText).filter(b => b.kind === 'build')

	for (const block of buildBlocks) {
		const blockImports = collectImportedSpecifiers(block.content)
		for (const [name, specifier] of blockImports) {
			merged.set(name, specifier)
		}
	}
	return merged
}

/** Extract all imported names and their specifiers from script text (default, named, namespace). Expects script content only, not full HTML. */
export function collectImportedSpecifiers(text: string): Map<string, string> {
	const imports = new Map<string, string>()
	try {
		const { imports: editorImports } = analyzeBuildScriptForEditor(text)
		for (const imp of editorImports) {
			const specifier = imp.specifier
			if (imp.defaultBinding) imports.set(imp.defaultBinding, specifier)
			if (imp.namespaceBinding) imports.set(imp.namespaceBinding, specifier)
			for (const { local } of imp.namedBindings) {
				imports.set(local, specifier)
			}
		}
	} catch {
		// Parse error; return empty map
	}
	return imports
}

/** Return the smallest scope that contains the given offset (for nested scopes). */
export function findInnermostScope(scopes: TemplateScope[], offset: number): TemplateScope | null {
	let best: TemplateScope | null = null
	for (const scope of scopes) {
		if (offset < scope.startOffset || offset > scope.endOffset) continue
		if (!best) {
			best = scope
			continue
		}
		const bestSize = best.endOffset - best.startOffset
		const thisSize = scope.endOffset - scope.startOffset
		if (thisSize <= bestSize) {
			best = scope
		}
	}
	return best
}

/** Build an array of byte ranges to ignore (HTML comments + script/style content). */
export function getIgnoredRanges(text: string): IgnoredRange[] {
	const ranges: IgnoredRange[] = []
	HTML_COMMENT_REGEX.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = HTML_COMMENT_REGEX.exec(text)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}

	const scriptStyleRegex = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi
	let scriptMatch: RegExpExecArray | null
	while ((scriptMatch = scriptStyleRegex.exec(text)) !== null) {
		const tagName = scriptMatch[1]
		const closeTagLen = `</${tagName}>`.length
		const contentLen = scriptMatch[2].length
		const start = scriptMatch.index + scriptMatch[0].length - closeTagLen - contentLen
		const end = start + contentLen
		ranges.push({ start, end })
	}

	for (const range of collectInterpolationBodyRanges(text, { attributeMode: false })) {
		ranges.push({ start: range.start - 1, end: range.end + 1 })
	}

	return ranges
}

/** Check whether an offset falls inside any of the given ranges. */
export function isInRanges(offset: number, ranges: IgnoredRange[]): boolean {
	for (const range of ranges) {
		if (offset >= range.start && offset < range.end) return true
	}
	return false
}
