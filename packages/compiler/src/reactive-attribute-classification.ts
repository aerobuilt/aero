/**
 * Reactive `{ stateRef }` attribute dispatch for `parseElementAttributes`.
 *
 * Build directives (`if`, `for`, `switch`, …) are classified first via
 * {@link classifyBuildAttribute}. This module owns the **binding** pipeline order
 * documented in {@link REACTIVE_BIND_DISPATCH_ORDER}.
 *
 * @see _reference/plans/Reactivity-Hypermedia/attribute-binding-refactor.plan.md
 */

import { tokenizeCurlyInterpolation, stripBraces } from '@aero-js/interpolation'
import { isDirectiveAttr } from './directive-attributes'
import { parseEventDirectiveName } from './event-directive-attributes'
import { normalizeRuntimeDirectiveName } from './runtime-directive-attributes'
import {
	bareAttributeName,
	idlPropertyNameForAttribute,
	isReactiveIdlPropertyAttribute,
} from './reactive-idl-properties'
import { referencesStateBindingExpression } from './state-mount-codegen'

/**
 * First-match dispatch order in `parseElementAttributes` after build-directive handling.
 * Keep in sync with {@link classifyReactiveAttribute}.
 */
export const REACTIVE_BIND_DISPATCH_ORDER = [
	'event-directive',
	'runtime-text',
	'runtime-busy',
	'runtime-show',
	'runtime-html',
	'runtime-class',
	'form-model',
	'idl-property',
	'attribute-bind',
] as const

export type ReactiveBindDispatchStep = (typeof REACTIVE_BIND_DISPATCH_ORDER)[number]

export interface ClassifyReactiveAttributeInput {
	tagName: string
	attrName: string
	rawValue: string | null | undefined
	/** `<input type="…">` — required for form-model classification on inputs. */
	inputType?: string | null
	/** When false, skip form-model / idl / attribute-bind (no `is:state`). */
	reactiveEnabled?: boolean
	stateBindingNames?: Iterable<string>
}

export type ReactiveAttributeClassification =
	| { kind: 'not-applicable' }
	| { kind: 'invalid-event-directive'; message: string }
	| { kind: 'event-directive' }
	| { kind: 'runtime-text' }
	| { kind: 'runtime-busy' }
	| { kind: 'runtime-show' }
	| { kind: 'runtime-html' }
	| { kind: 'runtime-class'; className: string }
	| { kind: 'form-model'; modelKind: 'value' | 'checked'; readonly: boolean }
	| { kind: 'idl-property'; bareName: string; propertyName: string }
	| { kind: 'attribute-bind'; bareName: string }

function isSingleWrappedExpression(value: string): boolean {
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

function isFormControlTag(tagName: string, inputType: string | null | undefined): boolean {
	const tag = tagName.toLowerCase()
	if (tag === 'textarea' || tag === 'select') return true
	if (tag !== 'input') return false
	const type = (inputType ?? 'text').toLowerCase()
	return !['button', 'submit', 'reset', 'image', 'hidden'].includes(type)
}

function referencesStateBindings(
	expr: string,
	stateBindingNames: Iterable<string> | undefined
): boolean {
	if (!stateBindingNames) return false
	const names =
		stateBindingNames instanceof Set ? stateBindingNames : new Set(stateBindingNames)
	return referencesStateBindingExpression(expr, names)
}

function classifyFormModel(
	tagName: string,
	attrName: string,
	raw: string,
	inputType: string | null | undefined,
	stateBindingNames: Iterable<string> | undefined
): Extract<ReactiveAttributeClassification, { kind: 'form-model' }> | null {
	if (!isSingleWrappedExpression(raw)) return null
	const expr = stripBraces(raw)
	if (!referencesStateBindings(expr, stateBindingNames)) return null

	const readonly = attrName.includes(':readonly') || attrName.endsWith('-readonly')
	const bare = bareAttributeName(attrName)

	let modelKind: 'value' | 'checked' | null = null
	if (bare === 'value' || bare.startsWith('value-')) modelKind = 'value'
	if (bare === 'checked' || bare.startsWith('checked-')) modelKind = 'checked'
	if (!modelKind || !isFormControlTag(tagName, inputType)) return null

	return { kind: 'form-model', modelKind, readonly }
}

/**
 * Classify which reactive bind dispatch step owns an element attribute.
 * Returns `not-applicable` for static attrs, third-party directives, and non-state `{ expr }`.
 */
export function classifyReactiveAttribute(
	input: ClassifyReactiveAttributeInput
): ReactiveAttributeClassification {
	const raw = input.rawValue ?? ''
	const tagName = input.tagName.toLowerCase()

	const parsedEvent = parseEventDirectiveName(input.attrName)
	if (parsedEvent.kind === 'invalid') {
		return { kind: 'invalid-event-directive', message: parsedEvent.message }
	}
	if (parsedEvent.kind === 'ok') {
		return { kind: 'event-directive' }
	}

	const parsedRuntime = normalizeRuntimeDirectiveName(input.attrName)
	if (parsedRuntime?.canonicalBareName === 'text') return { kind: 'runtime-text' }
	if (parsedRuntime?.canonicalBareName === 'busy') return { kind: 'runtime-busy' }
	if (parsedRuntime?.canonicalBareName === 'show') return { kind: 'runtime-show' }
	if (parsedRuntime?.canonicalBareName === 'html') return { kind: 'runtime-html' }
	if (parsedRuntime?.canonicalBareName?.startsWith('class-')) {
		return {
			kind: 'runtime-class',
			className: parsedRuntime.canonicalBareName.slice('class-'.length),
		}
	}

	if (!input.reactiveEnabled) return { kind: 'not-applicable' }
	if (isDirectiveAttr(input.attrName)) return { kind: 'not-applicable' }
	if (!isSingleWrappedExpression(raw)) return { kind: 'not-applicable' }

	const formModel = classifyFormModel(
		tagName,
		input.attrName,
		raw,
		input.inputType,
		input.stateBindingNames
	)
	if (formModel) return formModel

	const expr = stripBraces(raw)
	if (!referencesStateBindings(expr, input.stateBindingNames)) {
		return { kind: 'not-applicable' }
	}

	if (isReactiveIdlPropertyAttribute(input.attrName)) {
		const bareName = bareAttributeName(input.attrName)
		return {
			kind: 'idl-property',
			bareName,
			propertyName: idlPropertyNameForAttribute(input.attrName),
		}
	}

	return { kind: 'attribute-bind', bareName: bareAttributeName(input.attrName) }
}
