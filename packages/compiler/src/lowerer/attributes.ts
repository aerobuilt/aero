/**
 * Parse element and component DOM attributes for the lowerer (for, props, interpolation).
 */

import * as CONST from '../constants'
import * as Helper from '../helpers'
import {
	classifyBuildAttribute,
	getBuildDirectiveAttribute,
	hasBuildDirectiveAttribute,
	resolveBuildDirectiveName,
	type BuildDirective,
} from '../build-directive-attributes'
import { isKeyAttributeName, parseBindAttributePropName } from '../author-attribute-format'
import { isDirectiveAttr } from '../directive-attributes'
import { parentIsSwitchContainer } from './switch'
import { Resolver } from '../resolver'
import { CompileError } from '../types'
import { tokenizeCurlyInterpolation } from '../tokenizer'
import { parseForDirective, findForLoopImplicitNameShadows, type ParsedForDirective } from '../for-directive'
import { parseEventDirectiveName } from '../event-directive-attributes'
import { normalizeRuntimeDirectiveName } from '../runtime-directive-attributes'
import { resolveRuntimeDirectiveHasValue } from '../runtime-directive-braces'
import {
	deriveHypermediaFallbackAttrs,
	renderFallbackAttributeString,
	renderMethodOverrideInput,
} from '../hypermedia-fallback'
import type { IRReactiveBusyBind, IRReactiveEventBind, IRReactiveTextBind, IRReactiveShowBind, IRReactiveHtmlBind, IRReactiveClassBind, IRReactiveAttributeBind, IRReactivePropertyBind, IRReactiveModelBind } from '../ir'
import {
	isBooleanIdlProperty,
} from '../reactive-idl-properties'
import { classifyReactiveAttribute } from '../reactive-attribute-classification'
import type { LowererDiag, LowererReactiveState, ParsedComponentAttrs, ParsedElementAttrs } from './types'
import { referencesStateBindingExpression } from '../state-mount-codegen'

type AttrLike = { name: string; value?: string | null }
type NodeLike = {
	nodeType?: number
	tagName?: string
	attributes?: ArrayLike<AttrLike>
	hasAttribute?: (name: string) => boolean
}

const TEMPLATE_DIRECTIVE_ATTRS = [
	CONST.ATTR_IF,
	CONST.ATTR_ELSE_IF,
	CONST.ATTR_ELSE,
	CONST.ATTR_FOR,
	CONST.ATTR_SWITCH,
] as const

const NON_PROP_COMPONENT_DIRECTIVE_ATTRS = [
	...TEMPLATE_DIRECTIVE_ATTRS,
	CONST.ATTR_CASE,
	CONST.ATTR_DEFAULT,
] as const

function hasDirectiveAttr(node: NodeLike, directiveName: BuildDirective): boolean {
	return hasBuildDirectiveAttribute(node, directiveName)
}

function isDirectiveAttrName(attrName: string, directives: readonly BuildDirective[]): boolean {
	const resolved = resolveBuildDirectiveName(attrName)
	return resolved != null && directives.includes(resolved)
}

function getTagName(node: NodeLike): string {
	return node?.tagName?.toLowerCase?.() || 'element'
}

function forEachAttribute(node: NodeLike, visit: (attr: AttrLike) => void): void {
	const attrs = node?.attributes
	if (!attrs || attrs.length === 0) return
	for (let i = 0; i < attrs.length; i++) {
		visit(attrs[i])
	}
}

function validateBracedDirectiveValue(
	node: NodeLike,
	diag: LowererDiag,
	attrName: string,
	value: string
): string {
	return Helper.validateSingleBracedExpression(value, {
		directive: attrName,
		tagName: getTagName(node),
		diagnosticSource: diag?.source,
		diagnosticFile: diag?.file,
		positionNeedle: diag ? `${attrName}="${value}"` : undefined,
	})
}

function warnForLoopImplicitNameShadow(
	diag: LowererDiag,
	attr: AttrLike,
	inner: string
): void {
	if (!diag?.onWarning) return
	const shadowed = findForLoopImplicitNameShadows(inner)
	if (shadowed.length === 0) return
	const rawValue = attr.value || ''
	const needle = `${attr.name}="${rawValue}"`
	let line: number | undefined
	let column: number | undefined
	if (diag.source && needle.length > 0) {
		const idx = diag.source.indexOf(needle)
		if (idx >= 0) {
			const pos = Helper.lineColumnAtOffset(diag.source, idx)
			line = pos.line
			column = pos.column
		}
	}
	diag.onWarning({
		code: 'AERO_TEMPLATE',
		message:
			`for loop binding shadows built-in loop metadata (${shadowed.join(', ')}). ` +
			'Rename the binding to avoid shadowing index, first, last, or length.',
		...(line !== undefined && column !== undefined ? { line, column } : {}),
	})
}

function parseForAttribute(
	node: NodeLike,
	diag: LowererDiag,
	attr: AttrLike
): { binding: string; items: string } | null {
	if (resolveBuildDirectiveName(attr.name) !== CONST.ATTR_FOR) return null
	const classification = classifyBuildAttribute({
		tagName: getTagName(node),
		attrName: attr.name,
		rawValue: attr.value ?? null,
	})
	if (classification.kind === 'native-html' || classification.kind === 'not-build-directive') {
		return null
	}
	const rawValue = attr.value || ''
	const content = Helper.stripBraces(validateBracedDirectiveValue(node, diag, attr.name, rawValue))
	let parsed: ParsedForDirective
	try {
		parsed = parseForDirective(content)
	} catch (e) {
		const msg =
			e instanceof Error
				? e.message
				: `Directive \`${attr.name}\` on <${getTagName(node)}> must be a valid for…of head: const … of …`
		const needle = `${attr.name}="${rawValue}"`
		if (diag?.source && needle.length > 0) {
			const idx = diag.source.indexOf(needle)
			if (idx >= 0) {
				const { line, column } = Helper.lineColumnAtOffset(diag.source, idx)
				throw new CompileError({
					message: msg,
					file: diag.file,
					line,
					column,
				})
			}
		}
		if (diag?.file) {
			throw new CompileError({ message: msg, file: diag.file })
		}
		throw new Error(msg)
	}
	warnForLoopImplicitNameShadow(diag, attr, content)
	return { binding: parsed.binding, items: parsed.iterable }
}

function buildEmittedAttribute(resolver: Resolver, attr: AttrLike): string | null {
	const parsedEvent = parseEventDirectiveName(attr.name)
	if (parsedEvent.kind === 'ok') {
		const val = resolver.resolveAttrValue(attr.value ?? '')
		return `${parsedEvent.directive.canonicalName}="${val}"`
	}
	if (attr.name === CONST.ATTR_IS_INLINE) return null
	let val = resolver.resolveAttrValue(attr.value ?? '')
	if (!isDirectiveAttr(attr.name)) {
		val = Helper.compileAttributeInterpolation(val)
	}
	return `${attr.name}="${val}"`
}

function throwDirectiveError(
	node: NodeLike,
	diag: LowererDiag,
	attrName: string,
	attrValue: string | null | undefined,
	message: string
): never {
	const raw = attrValue ?? ''
	const needles = [`${attrName}="${raw}"`, `${attrName}='${raw}'`, attrName]
	const loc = Helper.locateInTemplateSource(diag?.source, { needles })
	if (diag?.file || loc) {
		throw new CompileError({ message, file: diag?.file, ...loc })
	}
	throw new Error(message)
}

function validateEventDirective(node: NodeLike, diag: LowererDiag, attr: AttrLike): void {
	const parsed = parseEventDirectiveName(attr.name)
	if (parsed.kind === 'non-event') return
	if (parsed.kind === 'invalid') {
		throwDirectiveError(
			node,
			diag,
			attr.name,
			attr.value,
			`Directive \`${attr.name}\` on <${getTagName(node)}> is invalid: ${parsed.message}`
		)
	}
	validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
}

export function warnWrapperlessTemplateAttributes(diag: LowererDiag, node: NodeLike): void {
	if (!diag?.onWarning) return
	if (node?.nodeType !== 1) return
	if (typeof node.tagName !== 'string' || getTagName(node) !== CONST.TAG_TEMPLATE) return
	if (!node.attributes || node.attributes.length === 0) return
	const isWrapperlessTemplate =
		hasDirectiveAttr(node, CONST.ATTR_IF) ||
		hasDirectiveAttr(node, CONST.ATTR_ELSE_IF) ||
		hasDirectiveAttr(node, CONST.ATTR_ELSE) ||
		hasDirectiveAttr(node, CONST.ATTR_FOR) ||
		hasDirectiveAttr(node, CONST.ATTR_SWITCH)
	if (!isWrapperlessTemplate) return

	const invalid: string[] = []
	forEachAttribute(node, attr => {
		if (!attr?.name) return
		if (isDirectiveAttrName(attr.name, TEMPLATE_DIRECTIVE_ATTRS)) return
		invalid.push(attr.name)
	})
	if (invalid.length === 0) return
	const unique = [...new Set(invalid)].sort()
	diag.onWarning({
		code: 'AERO_TEMPLATE',
		message:
			`Wrapperless <template> ignores non-directive attributes (${unique.join(', ')}). ` +
			'Move them to a real element inside the template block.',
	})
}

export function isSingleWrappedExpression(value: string): boolean {
	const trimmed = value.trim()
	if (!trimmed) return false
	const segments = tokenizeCurlyInterpolation(trimmed)
	return (
		segments.length === 1 &&
		segments[0].kind === 'interpolation' &&
		segments[0].start === 0 &&
		segments[0].end === trimmed.length
	)
}

/** Parses component attributes, extracting props and data-props */
export function parseComponentAttributes(node: NodeLike, diag: LowererDiag): ParsedComponentAttrs {
	const propsEntries: string[] = []
	let dataPropsExpression: string | null = null

	forEachAttribute(node, attr => {
		if (isDirectiveAttrName(attr.name, NON_PROP_COMPONENT_DIRECTIVE_ATTRS)) return

		if (resolveBuildDirectiveName(attr.name) === CONST.ATTR_PROPS) {
			const value = attr.value?.trim() || ''
			if (!value) {
				dataPropsExpression = '...props'
			} else {
				dataPropsExpression = Helper.stripBraces(
					validateBracedDirectiveValue(node, diag, attr.name, value)
				)
			}
			return
		}

		if (attr.name.endsWith(':readonly')) {
			throwDirectiveError(
				node,
				diag,
				attr.name,
				attr.value,
				`Component reactive prop \`${attr.name}\` is obsolete; use \`${attr.name.slice(0, -':readonly'.length)}="{ ... }"\` because reactive props are readonly by default.`
			)
		}

		const rawValue = attr.value ?? ''
		let propVal: string

		if (isSingleWrappedExpression(rawValue)) {
			propVal = Helper.stripBraces(rawValue)
		} else {
			const compiled = Helper.compileAttributeInterpolation(rawValue)
			const hasInterpolation = compiled.includes('${')
			propVal = hasInterpolation ? `\`${compiled}\`` : JSON.stringify(rawValue)
		}

		const propName = parseBindAttributePropName(attr.name) ?? attr.name
		propsEntries.push(`${JSON.stringify(propName)}: ${propVal}`)
	})

	const propsString = Helper.buildPropsString(propsEntries, dataPropsExpression)
	return { propsString }
}

/** Parses element attributes, extracting data-for and building the attribute string */
export function parseElementAttributes(
	resolver: Resolver,
	diag: LowererDiag,
	node: NodeLike,
	reactiveState?: LowererReactiveState,
	hypermedia?: boolean
): ParsedElementAttrs {
	const attributes: string[] = []
	const eventBinds: IRReactiveEventBind[] = []
	const textBinds: IRReactiveTextBind[] = []
	const busyBinds: IRReactiveBusyBind[] = []
	const showBinds: IRReactiveShowBind[] = []
	const htmlBinds: IRReactiveHtmlBind[] = []
	const classBinds: IRReactiveClassBind[] = []
	const attributeBinds: IRReactiveAttributeBind[] = []
	const propertyBinds: IRReactivePropertyBind[] = []
	const modelBinds: IRReactiveModelBind[] = []
	const pendingAttributeBindEntries: { name: string; readExpr: string }[] = []
	let prefixContent: string | undefined
	let loopData: { binding: string; items: string; keyExpr?: string } | null = null
	let keyExpr: string | undefined
	let switchExpr: string | null = null
	let passDataExpr: string | null = null

	forEachAttribute(node, attr => {
		if (!isKeyAttribute(attr.name)) return
		keyExpr = Helper.stripBraces(
			validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
		)
	})

	forEachAttribute(node, attr => {
		const parsedFor = parseForAttribute(node, diag, attr)
		if (parsedFor) {
			loopData = parsedFor
			return
		}

		if (isKeyAttribute(attr.name)) {
			return
		}

		// Conditional directives are never emitted; conditional lowering owns the element.
		if (isDirectiveAttrName(attr.name, [CONST.ATTR_IF, CONST.ATTR_ELSE_IF, CONST.ATTR_ELSE])) {
			return
		}

		// `case` / `default` are switch-branch markers consumed by switch lowering. Outside a switch
		// only a bare `default` on <track> survives (the native boolean); every other placement is a
		// misplaced branch that the lowerer's switch guard reports.
		if (isDirectiveAttrName(attr.name, [CONST.ATTR_CASE, CONST.ATTR_DEFAULT])) {
			const branchClassification = classifyBuildAttribute({
				tagName: getTagName(node),
				attrName: attr.name,
				rawValue: attr.value ?? null,
				parentHasSwitch: parentIsSwitchContainer(node),
			})
			if (
				branchClassification.kind === 'switch-branch' ||
				branchClassification.kind === 'misplaced-switch-branch'
			) {
				return
			}
		} else if (resolveBuildDirectiveName(attr.name) === CONST.ATTR_SWITCH) {
			const switchClassification = classifyBuildAttribute({
				tagName: getTagName(node),
				attrName: attr.name,
				rawValue: attr.value ?? null,
			})
			if (switchClassification.kind !== 'native-html') {
				switchExpr = Helper.stripBraces(
					validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
				)
				return
			}
		}

		if (resolveBuildDirectiveName(attr.name) === CONST.ATTR_PROPS) {
			const value = attr.value?.trim() || ''
			passDataExpr = value
				? validateBracedDirectiveValue(node, diag, attr.name, value)
				: '{ ...props }'
			return
		}

		validateEventDirective(node, diag, attr)
		const parsedEvent = parseEventDirectiveName(attr.name)
		if (parsedEvent.kind === 'ok' && reactiveState) {
			const handlerExpr = Helper.stripBraces(
				validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
			)
			const bindId = reactiveState.nextEventBindId()
			eventBinds.push({
				kind: 'ReactiveEventBind',
				bindId,
				event: parsedEvent.directive.event,
				modifiers: parsedEvent.directive.modifiers,
				handlerExpr,
			})
			attributes.push(`data-aero-event="${bindId}"`)
			if (hypermedia) {
				const fallback = deriveHypermediaFallbackAttrs(getTagName(node), {
					kind: 'ReactiveEventBind',
					bindId,
					event: parsedEvent.directive.event,
					modifiers: parsedEvent.directive.modifiers,
					handlerExpr,
				})
				if (fallback) {
					const fallbackStr = renderFallbackAttributeString(fallback)
					if (fallbackStr.trim()) attributes.push(fallbackStr.trim())
					if (fallback.methodOverride) {
						prefixContent = renderMethodOverrideInput(fallback.methodOverride)
					}
				}
			}
			return
		}

		const parsedRuntime = normalizeRuntimeDirectiveName(attr.name)
		if (parsedRuntime?.canonicalBareName === 'text' && reactiveState) {
			const text = attr.value || ''
			const readExpr = Helper.compileReactiveTextReadExpr(text)
			const bindId = reactiveState.nextTextBindId()
			textBinds.push({
				kind: 'ReactiveTextBind',
				bindId,
				readExpr,
			})
			attributes.push(`data-aero-text="${bindId}"`)
			return
		}

		if (parsedRuntime?.canonicalBareName === 'busy' && reactiveState) {
			const readExpr = Helper.stripBraces(
				validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
			)
			const bindId = reactiveState.nextBusyBindId()
			busyBinds.push({
				kind: 'ReactiveBusyBind',
				bindId,
				readExpr,
			})
			attributes.push(`data-aero-busy="${bindId}"`)
			return
		}

		if (parsedRuntime?.canonicalBareName === 'show' && reactiveState) {
			const readExpr = Helper.stripBraces(
				validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
			)
			const bindId = reactiveState.nextShowBindId()
			showBinds.push({ kind: 'ReactiveShowBind', bindId, readExpr })
			attributes.push(`data-aero-show="${bindId}"`)
			return
		}

		if (parsedRuntime?.canonicalBareName === 'html' && reactiveState) {
			const readExpr = Helper.stripBraces(
				validateBracedDirectiveValue(node, diag, attr.name, attr.value || '')
			)
			const bindId = reactiveState.nextHtmlBindId()
			htmlBinds.push({ kind: 'ReactiveHtmlBind', bindId, readExpr })
			attributes.push(`data-aero-html="${bindId}"`)
			return
		}

		if (parsedRuntime?.canonicalBareName?.startsWith('class-') && reactiveState) {
			const className = parsedRuntime.canonicalBareName.slice('class-'.length)
			// Prefer original template source: linkedom outerHTML collapses `attr=""` to bare.
			const sourceSlice =
				diag?.source ??
				(typeof (node as { outerHTML?: string }).outerHTML === 'string'
					? (node as { outerHTML: string }).outerHTML
					: undefined)
			const hasValue = resolveRuntimeDirectiveHasValue(attr.name, attr.value, sourceSlice)
			const readExpr = hasValue
				? Helper.stripBraces(
						validateBracedDirectiveValue(node, diag, attr.name, attr.value ?? '')
					)
				: className
			if (!referencesStateBindingExpression(readExpr, reactiveState.bindingNames)) {
				throwDirectiveError(
					node,
					diag,
					attr.name,
					attr.value,
					`Reactive class binding \`${attr.name}\` must reference a declared state variable.`
				)
			}
			const bindId = reactiveState.nextClassBindId()
			classBinds.push({ kind: 'ReactiveClassBind', bindId, className, readExpr })
			attributes.push(`data-aero-class-${className}="${bindId}"`)
			return
		}

		const modelBinding = parseFormModelBinding(node, diag, attr, reactiveState)
		if (modelBinding) {
			const { emittedAttrs, bind } = modelBinding
			modelBinds.push(bind)
			for (const emittedAttr of emittedAttrs) {
				attributes.push(emittedAttr)
			}
			return
		}

		const propertyBinding = parsePropertyBinding(node, diag, attr, reactiveState)
		if (propertyBinding) {
			for (const emittedAttr of propertyBinding.emittedAttrs) {
				attributes.push(emittedAttr)
			}
			propertyBinds.push(propertyBinding.bind)
			return
		}

		const attributeBinding = parseAttributeBindingEntry(node, diag, attr, reactiveState)
		if (attributeBinding) {
			pendingAttributeBindEntries.push(attributeBinding)
			attributes.push(
				Helper.compileAttributeBindEmission(attributeBinding.name, attributeBinding.readExpr)
			)
			return
		}

		const emitted = buildEmittedAttribute(resolver, attr)
		if (!emitted) return
		attributes.push(emitted)
	})

	if (pendingAttributeBindEntries.length > 0 && reactiveState) {
		const bindId = reactiveState.nextAttributeBindId()
		attributes.push(`data-aero-bind="${bindId}"`)
		attributeBinds.push({
			kind: 'ReactiveAttributeBind',
			bindId,
			attributes: pendingAttributeBindEntries,
		})
	}

	const attrString = attributes.length ? ' ' + attributes.join(' ') : ''
	type LoopData = { binding: string; items: string; keyExpr?: string }
	const loop = loopData as LoopData | null
	const resolvedLoopData: LoopData | null =
		loop && keyExpr ? { binding: loop.binding, items: loop.items, keyExpr } : loop
	return {
		attrString,
		prefixContent,
		loopData: resolvedLoopData,
		switchExpr,
		passDataExpr,
		eventBinds,
		textBinds,
		busyBinds,
		showBinds,
		htmlBinds,
		classBinds,
		attributeBinds,
		propertyBinds,
		modelBinds,
	}
}

function isKeyAttribute(name: string): boolean {
	return isKeyAttributeName(name)
}

function getInputType(node: NodeLike): string | null | undefined {
	return (node as { getAttribute?: (n: string) => string | null }).getAttribute?.('type') ?? undefined
}

function classifyAttrForReactiveBind(
	node: NodeLike,
	attr: AttrLike,
	reactiveState?: LowererReactiveState
) {
	return classifyReactiveAttribute({
		tagName: getTagName(node),
		attrName: attr.name,
		rawValue: attr.value,
		inputType: getInputType(node),
		reactiveEnabled: reactiveState != null,
		stateBindingNames: reactiveState?.bindingNames,
	})
}

function getInputValue(node: NodeLike): string | null {
	return (node as { getAttribute?: (n: string) => string | null }).getAttribute?.('value') ?? null
}

function parseFormModelBinding(
	node: NodeLike,
	diag: LowererDiag,
	attr: AttrLike,
	reactiveState?: LowererReactiveState
): { emittedAttrs: string[]; bind: IRReactiveModelBind } | null {
	if (!reactiveState) return null
	const classification = classifyAttrForReactiveBind(node, attr, reactiveState)
	if (classification.kind !== 'form-model') return null

	const raw = attr.value ?? ''
	const expr = Helper.stripBraces(raw)
	const bindId = reactiveState.nextModelBindId()
	const emittedAttrs: string[] = []
	const inputType = (getInputType(node) ?? 'text').toLowerCase()

	if (classification.modelKind === 'checked') {
		if (inputType === 'radio') {
			const inputValue = getInputValue(node) ?? ''
			emittedAttrs.push(
				Helper.compileBooleanPresenceAttr('checked', `${expr} === ${JSON.stringify(inputValue)}`)
			)
		} else {
			emittedAttrs.push(Helper.compileBooleanPresenceAttr('checked', expr))
		}
	} else if (classification.modelKind === 'value') {
		emittedAttrs.push(`value="${Helper.compileAttributeInterpolation(raw)}"`)
	}

	emittedAttrs.push(`data-aero-model-${classification.modelKind}="${bindId}"`)
	return {
		emittedAttrs,
		bind: {
			kind: 'ReactiveModelBind',
			bindId,
			modelKind: classification.modelKind,
			readExpr: expr,
			writeExpr: expr,
			...(classification.readonly ? { readonly: true } : {}),
		},
	}
}

function parseAttributeBindingEntry(
	node: NodeLike,
	diag: LowererDiag,
	attr: AttrLike,
	reactiveState?: LowererReactiveState
): { name: string; readExpr: string } | null {
	if (!reactiveState) return null
	const classification = classifyAttrForReactiveBind(node, attr, reactiveState)
	if (classification.kind !== 'attribute-bind') return null
	const expr = Helper.stripBraces(attr.value ?? '')
	return { name: classification.bareName, readExpr: expr }
}

function parsePropertyBinding(
	node: NodeLike,
	diag: LowererDiag,
	attr: AttrLike,
	reactiveState?: LowererReactiveState
): { emittedAttrs: string[]; bind: IRReactivePropertyBind } | null {
	if (!reactiveState) return null
	const classification = classifyAttrForReactiveBind(node, attr, reactiveState)
	if (classification.kind !== 'idl-property') return null

	const raw = attr.value ?? ''
	const expr = Helper.stripBraces(raw)
	const { bareName, propertyName } = classification
	const bindId = reactiveState.nextPropertyBindId()
	const emittedAttrs: string[] = []
	if (isBooleanIdlProperty(propertyName)) {
		emittedAttrs.push(Helper.compileBooleanPresenceAttr(bareName, expr))
	} else {
		const val = Helper.compileAttributeInterpolation(raw)
		emittedAttrs.push(`${bareName}="${val}"`)
	}
	emittedAttrs.push(`data-aero-property-${bareName}="${bindId}"`)
	return {
		emittedAttrs,
		bind: {
			kind: 'ReactivePropertyBind',
			bindId,
			propertyName,
			readExpr: expr,
		},
	}
}
