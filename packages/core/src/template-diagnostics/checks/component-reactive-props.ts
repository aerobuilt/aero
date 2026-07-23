/**
 * Reactive prop validation for component tags that receive state signals.
 */

import type { AeroDiagnostic } from '@aero-js/diagnostics'
import { pushOffsetDiagnostic } from '../aero-diagnostic-build'
import type { SourceDocument } from '../source-document'
import type { VariableDefinition } from '../analyzer'
import * as fs from 'node:fs'
import path from 'node:path'
import { collectComponentReactivePropMetadata } from '@aero-js/compiler'
import {
	attributeSectionBase,
	findAttributeRange,
	findTagNameRange,
	sliceRawAttrs,
	type ByteRange,
} from './helpers'

function getPassedReactivePropNames(
	attrs: string,
	stateVars: Map<string, VariableDefinition>
): Map<string, { bound: boolean; obsoleteReadonly: boolean; rawAttrName: string }> {
	const passed = new Map<
		string,
		{ bound: boolean; obsoleteReadonly: boolean; rawAttrName: string }
	>()
	const attrRegex =
		/(?:^|\s)([A-Za-z_:][A-Za-z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
	let m: RegExpExecArray | null
	attrRegex.lastIndex = 0
	while ((m = attrRegex.exec(attrs)) !== null) {
		const rawName = m[1]
		const value = (m[2] ?? m[3] ?? '').trim()
		const expr = value.match(/^\{\s*([A-Za-z_$][\w$]*)\s*\}$/)?.[1]
		if (!expr || !stateVars.has(expr)) continue
		const bound = rawName.startsWith('bind:')
		const obsoleteReadonly = rawName.endsWith(':readonly')
		const propName = bound
			? rawName.slice('bind:'.length)
			: obsoleteReadonly
				? rawName.slice(0, -':readonly'.length)
				: rawName
		passed.set(propName, { bound, obsoleteReadonly, rawAttrName: rawName })
	}
	return passed
}

function collectStateScriptContent(componentContent: string): string {
	const scripts: string[] = []
	const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
	let match: RegExpExecArray | null
	while ((match = scriptRegex.exec(componentContent)) !== null) {
		if (/\bis:state\b/.test(match[1])) scripts.push(match[2])
	}
	return scripts.join('\n')
}

function collectBindableReactivePropNames(componentContent: string): Set<string> {
	const stateScript = collectStateScriptContent(componentContent)
	const bindable = new Set<string>()
	const destructureRegex = /\bconst\s*\{([\s\S]*?)\}\s*=\s*Aero\.props\b/g
	let match: RegExpExecArray | null
	while ((match = destructureRegex.exec(stateScript)) !== null) {
		for (const rawPart of match[1].split(',')) {
			const part = rawPart.trim()
			if (!part || !/\bAero\.bindable\s*\(/.test(part)) continue
			const local = (part.includes(':') ? part.split(':').pop() : part)
				?.split('=')[0]
				?.trim()
			if (local && /^[A-Za-z_$][\w$]*$/.test(local)) bindable.add(local)
		}
	}
	return bindable
}

function reactivePropDiagnosticRange(
	tagStart: number,
	tagName: string,
	rawAttrs: string,
	attrBase: number,
	rawAttrName: string | null
): ByteRange {
	if (rawAttrName) {
		const attrRange = findAttributeRange(rawAttrs, attrBase, rawAttrName)
		if (attrRange) return attrRange
	}
	return findTagNameRange(tagStart, tagName)
}

function pushReactivePropDiagnostic(
	document: SourceDocument,
	diagnostics: AeroDiagnostic[],
	tagStart: number,
	tagName: string,
	rawAttrs: string,
	attrBase: number,
	rawAttrName: string | null,
	message: string
): void {
	const range = reactivePropDiagnosticRange(tagStart, tagName, rawAttrs, attrBase, rawAttrName)
	pushOffsetDiagnostic(diagnostics, document, range.start, range.end, message, 'AERO_COMPILE', 'error')
}

/**
 * Parent-side: every `bind:name="{ expr }"` must reference a writable `<script is:state>` binding.
 * Matches compile lowerer checks so build-only variables are flagged in the IDE.
 */
export function validateComponentBindRequiresState(
	document: SourceDocument,
	diagnostics: AeroDiagnostic[],
	tagStart: number,
	fullTag: string,
	tagName: string,
	stateVars: Map<string, VariableDefinition>
): void {
	const rawAttrs = sliceRawAttrs(tagName, fullTag)
	const attrBase = attributeSectionBase(tagStart, tagName)
	const attrRegex =
		/(?:^|\s)([A-Za-z_:][A-Za-z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
	let m: RegExpExecArray | null
	attrRegex.lastIndex = 0
	while ((m = attrRegex.exec(rawAttrs)) !== null) {
		const rawName = m[1]
		if (!rawName.startsWith('bind:')) continue
		const value = (m[2] ?? m[3] ?? '').trim()
		const expr = value.match(/^\{\s*([A-Za-z_$][\w$]*)\s*\}$/)?.[1]
		const inState = expr ? stateVars.has(expr) : false
		if (inState) continue
		const message =
			stateVars.size === 0
				? `Component bind prop \`${rawName}\` on <${tagName}> requires a writable state binding in \`<script is:state>\`.`
				: `Component bind prop \`${rawName}\` must reference one writable state binding.`
		pushReactivePropDiagnostic(
			document,
			diagnostics,
			tagStart,
			tagName,
			rawAttrs,
			attrBase,
			rawName,
			message
		)
	}
}

export function validateComponentReactiveProps(
	document: SourceDocument,
	diagnostics: AeroDiagnostic[],
	tagStart: number,
	fullTag: string,
	tagName: string,
	baseName: string,
	importName: string,
	resolvedPath: string,
	stateVars: Map<string, VariableDefinition>,
	readTextFile?: (absolutePath: string) => string | undefined
): void {
	if (stateVars.size === 0) return
	let metadata: ReturnType<typeof collectComponentReactivePropMetadata>
	try {
		metadata = collectComponentReactivePropMetadata(path.dirname(resolvedPath))
	} catch {
		return
	}
	const reactiveProps = metadata[importName] ?? metadata[baseName] ?? []
	const rawAttrs = sliceRawAttrs(tagName, fullTag)
	const attrBase = attributeSectionBase(tagStart, tagName)
	const passed = getPassedReactivePropNames(rawAttrs, stateVars)
	const componentContent =
		readTextFile?.(resolvedPath) ??
		(() => {
			try {
				return readTextFile?.(fs.realpathSync(resolvedPath))
			} catch {
				return undefined
			}
		})() ??
		fs.readFileSync(resolvedPath, 'utf-8')
	const bindableReactiveProps = collectBindableReactivePropNames(componentContent)
	const bindablePropNames = new Set<string>(bindableReactiveProps)
	for (const reactiveProp of reactiveProps) {
		const metadataBindable =
			(reactiveProp as typeof reactiveProp & { bindable?: boolean }).bindable === true
		if (!metadataBindable) continue
		bindablePropNames.add(reactiveProp.propName || reactiveProp.name)
		bindablePropNames.add(reactiveProp.name)
	}

	for (const [propName, passedProp] of passed) {
		if (!passedProp.bound) continue
		if (bindablePropNames.has(propName)) continue
		pushReactivePropDiagnostic(
			document,
			diagnostics,
			tagStart,
			tagName,
			rawAttrs,
			attrBase,
			passedProp.rawAttrName,
			`Child prop \`${propName}\` for <${tagName}> must be declared with \`Aero.bindable()\` before it can be passed with \`bind:${propName}\`.`
		)
	}

	for (const reactiveProp of reactiveProps) {
		const propName = reactiveProp.propName || reactiveProp.name
		const passedProp = passed.get(propName)
		const metadataBindable =
			(reactiveProp as typeof reactiveProp & { bindable?: boolean }).bindable === true
		const isBindable = metadataBindable || bindableReactiveProps.has(reactiveProp.name)
		if (passedProp?.obsoleteReadonly === true) {
			pushReactivePropDiagnostic(
				document,
				diagnostics,
				tagStart,
				tagName,
				rawAttrs,
				attrBase,
				passedProp.rawAttrName,
				`Component reactive prop \`${propName}:readonly\` is obsolete; use \`${propName}="{ ... }"\` because reactive props are readonly by default.`
			)
			continue
		}
		if (isBindable && passedProp && !passedProp.bound) {
			pushReactivePropDiagnostic(
				document,
				diagnostics,
				tagStart,
				tagName,
				rawAttrs,
				attrBase,
				passedProp.rawAttrName,
				`Bindable prop \`${propName}\` for <${tagName}> must be passed with \`bind:${propName}="{ ... }"\`.`
			)
			continue
		}
		if (!reactiveProp.required) continue
		if (passedProp) continue
		pushReactivePropDiagnostic(
			document,
			diagnostics,
			tagStart,
			tagName,
			rawAttrs,
			attrBase,
			null,
			isBindable
				? `Required bindable prop \`${propName}\` for <${tagName}> must be passed with \`bind:${propName}="{ ... }"\`.`
				: `Required reactive prop \`${propName}\` for <${tagName}> must be passed as a state signal.`
		)
	}
}
