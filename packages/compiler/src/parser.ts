import type { ParseResult, ScriptEntry } from './types'

import {
	isOffsetInRanges,
	collectInterpolationBodyRanges,
	encodeBraceCharacterReferences,
	escapeEntityEncodedElementMarkup,
	escapeInterpolationBodyMarkup,
} from '@aero-js/interpolation'
import { parseHTML } from 'linkedom'
import * as CONST from './constants'
import { AERO_ATTR_PREFIX, DATA_AERO_ATTR_PREFIX } from './constants'
import {
	elementHasScriptIsAttribute,
	removeScriptIsAttribute,
	scriptIsAttributeNames,
	type PrefixableScriptIsKind,
} from './author-attribute-format'

const BOM_PREFIX = /^\uFEFF/
const FRAGMENT_DOCUMENT_PREFIX = '<html><head></head><body>'
const FRAGMENT_DOCUMENT_SUFFIX = '</body></html>'

const DATA_PROPS_ATTRS = [
	`${AERO_ATTR_PREFIX}${CONST.ATTR_PROPS}`,
	`${DATA_AERO_ATTR_PREFIX}${CONST.ATTR_PROPS}`,
]

const SCRIPT_IS_KINDS = ['build', 'state', 'inline', 'blocking'] as const satisfies readonly PrefixableScriptIsKind[]

const SCRIPT_TAXONOMY_ATTRS = new Set(SCRIPT_IS_KINDS.flatMap(kind => [...scriptIsAttributeNames(kind)]))

const CLIENT_SCRIPT_EXCLUDED_ATTRS = new Set([
	...SCRIPT_TAXONOMY_ATTRS,
	CONST.ATTR_PROPS,
	...DATA_PROPS_ATTRS,
])

const SCRIPT_TAXONOMY_ATTRS_LOWER = new Set(
	[...SCRIPT_TAXONOMY_ATTRS].map(value => value.toLowerCase())
)
const CLIENT_SCRIPT_EXCLUDED_ATTRS_LOWER = new Set(
	[...CLIENT_SCRIPT_EXCLUDED_ATTRS].map(value => value.toLowerCase())
)

function isTagNameChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9-]/.test(char)
}

function findTagEnd(html: string, start: number): number {
	let quote: '"' | "'" | null = null
	for (let i = start; i < html.length; i++) {
		const char = html[i]
		if (quote) {
			if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === '>') return i
	}
	return -1
}

function findSelfClosingSlash(html: string, tagEnd: number): number {
	let i = tagEnd - 1
	while (i >= 0 && /\s/.test(html[i] ?? '')) i--
	return html[i] === '/' ? i : -1
}

function findRawTagClose(html: string, tagName: string, from: number): number {
	const lower = html.toLowerCase()
	const closeNeedle = `</${tagName}`
	let idx = lower.indexOf(closeNeedle, from)
	while (idx !== -1) {
		const next = html[idx + closeNeedle.length]
		if (!isTagNameChar(next)) {
			const end = findTagEnd(html, idx + closeNeedle.length)
			return end === -1 ? html.length - 1 : end
		}
		idx = lower.indexOf(closeNeedle, idx + closeNeedle.length)
	}
	return -1
}

export function expandSelfClosingTags(html: string): string {
	let out = ''
	let cursor = 0
	const interpolationBodies = collectInterpolationBodyRanges(html)

	while (cursor < html.length) {
		const tagStart = html.indexOf('<', cursor)
		if (tagStart === -1) {
			out += html.slice(cursor)
			break
		}

		out += html.slice(cursor, tagStart)
		if (isOffsetInRanges(tagStart, interpolationBodies)) {
			out += '<'
			cursor = tagStart + 1
			continue
		}
		const firstTagChar = html[tagStart + 1]
		if (!isTagNameChar(firstTagChar)) {
			out += '<'
			cursor = tagStart + 1
			continue
		}

		let nameEnd = tagStart + 1
		while (isTagNameChar(html[nameEnd])) nameEnd++
		const tagName = html.slice(tagStart + 1, nameEnd)
		const tagEnd = findTagEnd(html, nameEnd)
		if (tagEnd === -1) {
			out += html.slice(tagStart)
			break
		}
		if (tagName.toLowerCase() === 'script') {
			const closeEnd = findRawTagClose(html, 'script', tagEnd + 1)
			if (closeEnd === -1) {
				out += html.slice(tagStart)
				break
			}
			out += html.slice(tagStart, closeEnd + 1)
			cursor = closeEnd + 1
			continue
		}

		const selfClosingSlash = findSelfClosingSlash(html, tagEnd)
		if (selfClosingSlash === -1) {
			out += html.slice(tagStart, tagEnd + 1)
			cursor = tagEnd + 1
			continue
		}

		const openingTag = html.slice(tagStart, selfClosingSlash)
		if (CONST.VOID_TAGS.has(tagName.toLowerCase())) {
			out += `${openingTag}>`
		} else {
			out += `${openingTag}></${tagName}>`
		}
		cursor = tagEnd + 1
	}

	return out
}

/** Serialize element attributes to a string, excluding given names (case-insensitive). Values are XML-escaped. */
function getAttrsString(element: Element, excludeLower: ReadonlySet<string>): string {
	const parts: string[] = []
	const attrs = element.attributes
	if (!attrs) return ''
	for (let i = 0; i < attrs.length; i++) {
		const a = attrs[i]
		if (!a || excludeLower.has(a.name.toLowerCase())) continue
		const value = a.value
		const escaped = value
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
		parts.push(`${a.name}="${escaped}"`)
	}
	return parts.join(' ').trim()
}

/** Classification of script element placement in ancestor tree. */
interface ScriptPlacement {
	inHead: boolean
	inForeignNamespace: boolean
}

interface ScriptClassification {
	placement: ScriptPlacement
	hasBuild: boolean
	hasState: boolean
	hasInline: boolean
	hasBlocking: boolean
	src: string
	passData: string | undefined
	cleanedAttrs: string
	content: string
}

interface ScriptElementWithPlacement {
	element: Element
	placement: ScriptPlacement
}

/** Classify whether an element is inside head and/or foreign namespace ancestors. */
function getScriptPlacement(el: Element): ScriptPlacement {
	let inHead = false
	let inForeignNamespace = false
	let parent = el.parentElement
	while (parent) {
		const tag = parent.tagName?.toLowerCase()
		if (tag === 'head') inHead = true
		if (tag === 'svg' || tag === 'math') inForeignNamespace = true
		if (inHead && inForeignNamespace) break
		parent = parent.parentElement
	}
	return { inHead, inForeignNamespace }
}

/** Collect all <script> elements in document order that are not inside SVG/MathML. */
function collectScriptElements(doc: Document): ScriptElementWithPlacement[] {
	const scripts: ScriptElementWithPlacement[] = []
	const walk = (node: Node) => {
		if (node.nodeType === 1) {
			const el = node as Element
			if (el.tagName?.toLowerCase() === 'script') {
				const placement = getScriptPlacement(el)
				if (!placement.inForeignNamespace) scripts.push({ element: el, placement })
				return
			}
		}
		for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
	}
	// Walk from document root so we collect scripts in head, body, and any before <html> (e.g. is:build)
	walk(doc)
	return scripts
}

function parseDocument(html: string, isFullDocument: boolean): Document {
	if (isFullDocument) {
		return parseHTML(html).document
	}
	return parseHTML(`${FRAGMENT_DOCUMENT_PREFIX}${html}${FRAGMENT_DOCUMENT_SUFFIX}`).document
}

function serializeTemplate(doc: Document, isFullDocument: boolean): string {
	if (isFullDocument) {
		let out = ''
		for (const node of doc.childNodes) {
			if (node.nodeType === 1) {
				out += (node as Element).outerHTML
			} else if (node.nodeType === 3) {
				out += node.textContent ?? ''
			}
		}
		return out || doc.documentElement?.outerHTML || String(doc)
	}
	return doc.body?.innerHTML ?? ''
}

function getPrefixedPropsAttribute(scriptEl: Element): { name: string; value: string | null } | null {
	for (const name of DATA_PROPS_ATTRS) {
		if (scriptEl.hasAttribute(name)) {
			return { name, value: scriptEl.getAttribute(name) }
		}
	}
	return null
}

function getPassData(scriptEl: Element): string | undefined {
	const prefixed = getPrefixedPropsAttribute(scriptEl)
	let passData =
		scriptEl.getAttribute(CONST.ATTR_PROPS) ?? prefixed?.value ?? undefined
	const hasProps = scriptEl.hasAttribute(CONST.ATTR_PROPS) || prefixed != null
	// Bare props shorthand: no value → spread local props
	if (passData === '' && hasProps) {
		passData = '{ ...props }'
	}
	return passData
}

function getCleanedScriptAttrs(scriptEl: Element, hasInline: boolean, inHead: boolean): string {
	const excludedAttrs =
		!hasInline && !inHead ? CLIENT_SCRIPT_EXCLUDED_ATTRS_LOWER : SCRIPT_TAXONOMY_ATTRS_LOWER
	return getAttrsString(scriptEl, excludedAttrs).replace(/\s+/g, ' ').trim()
}

function classifyScriptElement(
	scriptEl: Element,
	placement: ScriptPlacement
): ScriptClassification {
	const hasBuild = elementHasScriptIsAttribute(scriptEl, 'build')
	const hasState = elementHasScriptIsAttribute(scriptEl, 'state')
	const hasInline = elementHasScriptIsAttribute(scriptEl, 'inline')
	return {
		placement,
		hasBuild,
		hasState,
		hasInline,
		hasBlocking: elementHasScriptIsAttribute(scriptEl, 'blocking'),
		src: scriptEl.getAttribute(CONST.ATTR_SRC) ?? '',
		passData: getPassData(scriptEl),
		cleanedAttrs: getCleanedScriptAttrs(scriptEl, hasInline, placement.inHead),
		content: (scriptEl.textContent ?? '').trim(),
	}
}

function pushInlineScript(inlineScripts: ScriptEntry[], script: ScriptClassification): void {
	inlineScripts.push({
		attrs: script.cleanedAttrs,
		content: script.content,
		passDataExpr: script.passData,
	})
}

function pushBlockingScript(blockingScripts: ScriptEntry[], script: ScriptClassification): void {
	blockingScripts.push({
		attrs: script.cleanedAttrs,
		content: script.content,
		passDataExpr: script.passData,
	})
}

function pushClientScript(clientScripts: ScriptEntry[], script: ScriptClassification): void {
	clientScripts.push({
		attrs: script.cleanedAttrs,
		content: script.content,
		passDataExpr: script.passData,
		injectInHead: script.placement.inHead,
	})
}

function isLocalScriptSource(src: string): boolean {
	return !src.startsWith('http://') && !src.startsWith('https://')
}

/**
 * Parse HTML and extract Aero script blocks; return build script, client/inline/blocking script arrays, and template.
 *
 * @remarks
 * DOM-first approach: parse full document with linkedom, walk script elements (skipping SVG/MathML),
 * classify by attributes (is:build, is:state, is:inline, is:blocking, src, props), mutate DOM (remove/replace),
 * then serialize to produce template. Scripts inside HTML comments are not in the DOM and are left in place.
 * BOM is stripped first.
 *
 * @param html - Full template HTML (may include BOM).
 * @returns ParseResult with buildScript, clientScripts, inlineScripts, blockingScripts, and template (script blocks removed/replaced).
 */
export function parse(html: string): ParseResult {
	html = encodeBraceCharacterReferences(html.replace(BOM_PREFIX, ''))

	const { text: escapedHtml, restore } = escapeInterpolationBodyMarkup(
		escapeEntityEncodedElementMarkup(html)
	)

	// Expand non-void self-closing tags so the HTML5 parser (linkedom) builds correct DOM.
	// Otherwise e.g. <nav-component /> is parsed as opening-only and swallows following siblings.
	let htmlForParse = expandSelfClosingTags(escapedHtml)

	const isFullDocument = /<\s*html[\s>]/i.test(htmlForParse)
	const doc = parseDocument(htmlForParse, isFullDocument)

	const buildContent: string[] = []
	const stateContent: string[] = []
	const clientScripts: ScriptEntry[] = []
	const inlineScripts: ScriptEntry[] = []
	const blockingScripts: ScriptEntry[] = []

	const scriptElements = collectScriptElements(doc)
	const toRemove: Element[] = []

	for (const { element: scriptEl, placement } of scriptElements) {
		const script = classifyScriptElement(scriptEl, placement)

		if (script.hasBuild) {
			buildContent.push(script.content)
			toRemove.push(scriptEl)
			continue
		}

		if (script.hasState) {
			stateContent.push(script.content)
			toRemove.push(scriptEl)
			continue
		}

		if (script.hasInline) {
			pushInlineScript(inlineScripts, script)
			// Strip is:inline (any supported prefix spelling) so serialized template has a clean script tag
			removeScriptIsAttribute(scriptEl, 'inline')
			continue
		}

		if (script.hasBlocking) {
			pushBlockingScript(blockingScripts, script)
			toRemove.push(scriptEl)
			continue
		}

		if (script.src) {
			const hasType = scriptEl.hasAttribute('type')
			if (isLocalScriptSource(script.src) && !hasType) {
				// Mutate in place: add type=module, strip defer (redundant with module)
				scriptEl.setAttribute('type', 'module')
				scriptEl.removeAttribute('defer')
			}
			continue
		}
		// Head scripts with attributes (e.g. props) stay inline unless they use ESM imports (bundled client module).
		if (script.placement.inHead && scriptEl.attributes.length > 0) {
			if (!/\bimport\s/.test(script.content)) continue
		}
		// Plain script (no attrs or body): extract as client
		pushClientScript(clientScripts, script)
		toRemove.push(scriptEl)
	}

	for (const el of toRemove) el.remove()

	if (stateContent.length > 1) {
		throw new Error('[aero] Only one <script is:state> is allowed per template.')
	}

	const buildScript = buildContent.length > 0 ? { content: buildContent.join('\n') } : null
	const stateScript = stateContent.length > 0 ? { content: stateContent[0] } : null

	const template = restore(serializeTemplate(doc, isFullDocument).trim())

	return {
		buildScript,
		stateScript,
		clientScripts,
		inlineScripts,
		blockingScripts,
		template,
	}
}
