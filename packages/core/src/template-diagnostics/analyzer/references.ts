import { tokenizeCurlyInterpolation } from '@aero-js/interpolation'
import { parseAeroHtmlDocument, walkHtmlNodes } from '@aero-js/html-parser'
import { maskHtmlComments } from '@aero-js/compiler'
import { parseScriptBlocks } from '../script-tag'
import { rangeFromOffsets, type SourceDocument } from '../source-document'
import {
	escapeInterpolationBodyMarkup,
	isInsideHtmlComment,
	maskJsComments,
	maskTemplateLiteralStatic,
} from './helpers'
import { isJsReservedIdentifier } from './js-keywords'
import type { TemplateReference } from './types'

const STANDALONE_ATTR_VARIABLE_REFS = new Set(['props', 'aero-props', 'data-aero-props'])

export function collectBuildScriptContentGlobalReferences(
	document: SourceDocument,
	text: string,
	contentGlobalNames: ReadonlySet<string>
): TemplateReference[] {
	const refs: TemplateReference[] = []
	const buildBlocks = parseScriptBlocks(text).filter(
		b => b.kind === 'build' && !isInsideHtmlComment(text, b.tagStart)
	)

	for (const block of buildBlocks) {
		const maskedContent = maskJsComments(block.content)
		extractIdentifiers(maskedContent, block.contentStart, document, refs, false)
	}
	return refs.filter(r => contentGlobalNames.has(r.content))
}

export function collectTemplateReferences(
	document: SourceDocument,
	text: string
): TemplateReference[] {
	const refs: TemplateReference[] = []

	let maskedText = text.replace(
		/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi,
		(match, _tag, content) => {
			return match.replace(content, ' '.repeat(content.length))
		}
	)

	maskedText = maskHtmlComments(maskedText)

	const htmlDoc = parseAeroHtmlDocument(
		escapeInterpolationBodyMarkup(maskedText).text,
		document.uri.fsPath
	)
	for (const node of walkHtmlNodes(htmlDoc.roots)) {
		if (!node.tag || node.startTagEnd == null) continue
		const tl = node.tag.toLowerCase()
		if (tl === 'script' || tl === 'style') continue
		if (isInsideHtmlComment(text, node.start)) continue

		const open = text.slice(node.start, node.startTagEnd)
		const nameMatch = open.match(/^<\s*\/?\s*([a-zA-Z][\w-]*)/)
		if (!nameMatch) continue
		const tagName = nameMatch[1]

		if (tagName.endsWith('-component') || tagName.endsWith('-layout')) {
			const suffix = tagName.endsWith('-component') ? '-component' : '-layout'
			const prefix = tagName.slice(0, -suffix.length)
			const nameStartInOpen = nameMatch.index! + nameMatch[0].length - tagName.length
			const absPrefixStart = node.start + nameStartInOpen

			refs.push({
				content: prefix.replace(/-([a-z])/g, g => g[1].toUpperCase()),
				range: rangeFromOffsets(document, absPrefixStart, absPrefixStart + prefix.length),
				offset: absPrefixStart,
				isAttribute: false,
				isComponent: true,
			})
		}

		const attrsStart = node.start + nameMatch[0].length
		const gt = open.lastIndexOf('>')
		const attrsContent = gt > nameMatch[0].length ? open.slice(nameMatch[0].length, gt) : ''

		const maskRange = (start: number, length: number) => {
			maskedText =
				maskedText.substring(0, start) + ' '.repeat(length) + maskedText.substring(start + length)
		}

		const attrRegex = /(?:\s|^)([a-zA-Z0-9-:@.]+)(?:(\s*=\s*)(['"])([\s\S]*?)\3)?/gi
		let attrMatch: RegExpExecArray | null

		while ((attrMatch = attrRegex.exec(attrsContent)) !== null) {
			const fullMatch = attrMatch[0]
			const name = attrMatch[1]
			const hasValue = !!attrMatch[3]
			const value = attrMatch[4] || ''

			const matchStartInAttrs = attrMatch.index
			const nameStartInMatch = fullMatch.indexOf(name)
			const absNameStart = attrsStart + matchStartInAttrs + nameStartInMatch

			const isAlpine = name.startsWith(':') || name.startsWith('@') || name.startsWith('x-')

			if (hasValue) {
				const quote = attrMatch[3]
				const quoteIndex = fullMatch.indexOf(quote, nameStartInMatch + name.length)
				const absValueStart = attrsStart + matchStartInAttrs + quoteIndex + 1

				if (isAlpine) {
					extractIdentifiers(value, absValueStart, document, refs, true, true)
					maskRange(absValueStart, value.length)
				} else {
					const segments = tokenizeCurlyInterpolation(value)
					for (const seg of segments) {
						if (seg.kind === 'interpolation') {
							const contentStart = absValueStart + seg.start + 1
							extractIdentifiers(seg.expression, contentStart, document, refs, true)
						}
					}
					maskRange(absValueStart, value.length)
				}
			} else {
				if (STANDALONE_ATTR_VARIABLE_REFS.has(name)) {
					refs.push({
						content: 'props',
						range: rangeFromOffsets(document, absNameStart, absNameStart + name.length),
						offset: absNameStart,
						isAttribute: true,
					})
				}
			}
		}
	}

	const contentSegments = tokenizeCurlyInterpolation(maskedText)
	for (const seg of contentSegments) {
		if (seg.kind === 'interpolation') {
			const contentStart = seg.start + 1
			extractIdentifiers(seg.expression, contentStart, document, refs, false)
		}
	}

	return refs
}

export function collectIdentifierReferences(
	document: SourceDocument,
	content: string,
	startOffset: number,
	isAttribute = false
): TemplateReference[] {
	const refs: TemplateReference[] = []
	extractIdentifiers(content, startOffset, document, refs, isAttribute)
	return refs
}

function extractIdentifiers(
	content: string,
	startOffset: number,
	document: SourceDocument,
	refs: TemplateReference[],
	isAttribute: boolean,
	isAlpine?: boolean
) {
	let maskedContent = maskJsComments(content)
	maskedContent = maskTemplateLiteralStatic(maskedContent)
	maskedContent = maskedContent.replace(/(['"])(?:(?=(\\?))\2.)*?\1/g, match =>
		' '.repeat(match.length)
	)

	const idRegex = /\b([a-zA-Z_$][\w$]*)\b/g
	let match: RegExpExecArray | null
	while ((match = idRegex.exec(maskedContent)) !== null) {
		const id = match[1]
		if (isJsReservedIdentifier(id)) continue

		const indexInContent = match.index
		const charBefore = indexInContent > 0 ? content[indexInContent - 1] : ''
		if (charBefore === '.') {
			const isSpread =
				indexInContent >= 3 && content.slice(indexInContent - 3, indexInContent) === '...'
			if (!isSpread) continue
		}

		const afterId = content.slice(indexInContent + id.length)
		if (/^\s*:\s*/.test(afterId)) {
			continue
		}

		const propertyPath: string[] = []
		const propertyRanges: TemplateReference['propertyRanges'] = []

		let currentAfter = maskedContent.slice(indexInContent + id.length)
		let currentOffsetRel = indexInContent + id.length

		const propRegex = /^\s*\.\s*([a-zA-Z_$][\w$]*)/
		let propMatch
		while ((propMatch = propRegex.exec(currentAfter))) {
			const propName = propMatch[1]
			propertyPath.push(propName)

			const matchStartInAfter = propMatch.index
			const nameStartInMatch = propMatch[0].lastIndexOf(propName)
			const propAbsStart = startOffset + currentOffsetRel + matchStartInAfter + nameStartInMatch

			propertyRanges!.push(
				rangeFromOffsets(document, propAbsStart, propAbsStart + propName.length)
			)

			const matchLen = propMatch[0].length
			currentAfter = currentAfter.slice(matchLen)
			currentOffsetRel += matchLen
		}

		const absStart = startOffset + match.index
		const ref: TemplateReference = {
			content: id,
			range: rangeFromOffsets(document, absStart, absStart + id.length),
			offset: absStart,
			isAttribute,
			isAlpine,
		}

		if (propertyPath.length > 0) {
			ref.propertyPath = propertyPath
			ref.propertyRanges = propertyRanges
		}

		refs.push(ref)
	}
}
