/**
 * Walks linkedom DOM and lowers to IR (elements, components, slots, for, if/else chains, switch).
 *
 * @remarks
 * **`<template>`:** A plain `<template>` in source is still lowered through {@link compileElement},
 * which emits `<template>...</template>`. **Wrapperless** cases (no `<template>` in output,
 * children from `template.content`): `if` / `else-if` / `else` chains via
 * {@link compileWrapperAwareBranch}; `data-for` / `for` on `<template>` via
 * {@link compileWrapperlessNode} for the loop body.
 */
import type { IRNode, IRComponentReactivePropExpr } from '../ir'
import type { LowererDiag, LowererReactiveState } from './types'

import * as CONST from '../constants'
import { getBuildDirectiveAttribute } from '../build-directive-attributes'
import { parseBindAttributePropName } from '../author-attribute-format'
import * as Helper from '../helpers'
import { tokenizeCurlyInterpolation } from '../tokenizer'
import { textReferencesStateBindings, referencesStateBindingExpression } from '../state-mount-codegen'
import {
	findUndeclaredReactiveIdentifiers,
	REACTIVE_EXPR_AMBIENT_GLOBALS,
} from '../scope-expr-codegen'
import { findBracedIdentifierOffsets } from '../template-source-map'
import { Resolver } from '../resolver'
import { CompileError, type ComponentReactivePropMetadata } from '../types'
import { buildForLoopBodyScopeNames, collectForDirectiveBindingNames } from '../for-directive'
import {
	parseComponentAttributes,
	parseElementAttributes,
	isSingleWrappedExpression,
	warnWrapperlessTemplateAttributes,
} from './attributes'
import { compileConditionalChain, hasElseAttr, hasElseIfAttr, hasIfAttr } from './conditionals'
import {
	compileElementDefaultContent,
	compileSlot,
	compileSlotDefaultContent,
	type SlotDefaultContentDeps,
} from './slots'
import { compileSwitchContainer, hasCaseAttr, parentIsSwitchContainer, isReactiveSwitch } from './switch'
import { getEffectiveChildNodes, isTemplateElement } from './template'
import {
	findOnlyElementSibling,
	firstIfChainIndex,
	injectReactiveMarkerOnOpenTag,
	isIgnorableSibling,
	isOnlySiblingContent,
} from './anchor-hoist'
import { emitCommentEnd, emitCommentStart } from '../anchor-markers'

interface ChildHoistContext {
	forHoistBindId?: number
	ifHoistBindId?: number
	textHoistBindId?: number
	forBodyScopeNames?: ReadonlySet<string>
}

/** Internal lowerer: walks DOM nodes and builds IR; used by compile(). */
export class Lowerer {
	private resolver: Resolver
	private slotCounter = 0
	private readonly diag: LowererDiag
	private readonly reactiveState: LowererReactiveState | null
	/** Build-script bindings visible in `{ }` when `<script is:state>` is also present. */
	private readonly buildScopeNames: ReadonlySet<string>

	private readonly hypermedia: boolean
	private readonly componentReactiveProps: Record<string, readonly ComponentReactivePropMetadata[]>

	constructor(
		resolver: Resolver,
		diag?: LowererDiag,
		stateBindingNames?: ReadonlySet<string>,
		options?: {
			writableStateBindingNames?: ReadonlySet<string>
			buildScopeNames?: ReadonlySet<string>
			hypermedia?: boolean
			componentReactiveProps?: Record<string, readonly ComponentReactivePropMetadata[]>
		}
	) {
		this.resolver = resolver
		this.diag = diag
		this.buildScopeNames = options?.buildScopeNames ?? new Set()
		this.hypermedia = options?.hypermedia === true
		this.componentReactiveProps = options?.componentReactiveProps ?? {}
		this.reactiveState =
			stateBindingNames && stateBindingNames.size > 0
				? createLowererReactiveState(
						stateBindingNames,
						options?.writableStateBindingNames ?? stateBindingNames
					)
				: null
	}

	private get slotDeps(): SlotDefaultContentDeps {
		return {
			parseElementAttributes: (n: any) =>
				parseElementAttributes(
					this.resolver,
					this.diag,
					n,
					this.reactiveState ?? undefined,
					this.hypermedia
				),
			parseComponentAttributes: (n: any) => parseComponentAttributes(n, this.diag),
		}
	}

	private compileSlotDefaultContent(
		nodes: NodeList | undefined,
		skipInterpolation: boolean
	): string {
		return compileSlotDefaultContent(nodes, skipInterpolation, this.slotDeps, (n, s) =>
			this.compileElementDefaultContent(n, s)
		)
	}

	private compileElementDefaultContent(node: any, skipInterpolation: boolean): string {
		return compileElementDefaultContent(node, skipInterpolation, this.slotDeps, (nodes, skip) =>
			this.compileSlotDefaultContent(nodes, skip)
		)
	}

	compileNode(node: any, skipInterpolation = false, outVar = '__out', parentHoist?: ChildHoistContext): IRNode[] {
		switch (node.nodeType) {
			case 3:
				return this.compileText(node, skipInterpolation, outVar, parentHoist)
			case 1:
				return this.compileElement(node, skipInterpolation, outVar, parentHoist)
			default:
				return []
		}
	}

	compileFragment(nodes: NodeList | undefined): IRNode[] {
		return this.compileChildNodes(nodes, false, '__out')
	}

	/**
	 * Compiles `node`'s inner structure via {@link getEffectiveChildNodes} without emitting the
	 * node's outer tags. For `<template>`, inner markup comes from `template.content`, so output
	 * IR never includes `<template>` / `</template>`.
	 */
	compileWrapperlessNode(
		node: any,
		skipInterpolation: boolean,
		outVar: string,
		parentHoist?: ChildHoistContext
	): IRNode[] {
		const children = getEffectiveChildNodes(node)
		return this.compileChildNodes(children, skipInterpolation, outVar, parentHoist)
	}

	/**
	 * Compiles a branch body: {@link compileElement} for normal elements; for `<template>` only,
	 * {@link compileWrapperlessNode} so the tag is not present in the output. Used by conditional
	 * chains and intended for `switch` branches.
	 */
	compileWrapperAwareBranch(node: any, skipInterpolation: boolean, outVar: string): IRNode[] {
		if (isTemplateElement(node)) {
			warnWrapperlessTemplateAttributes(this.diag, node)
			return this.compileWrapperlessNode(node, skipInterpolation, outVar)
		}
		return this.compileElement(node, skipInterpolation, outVar)
	}

	private compileChildNodes(
		nodes: NodeList | undefined,
		skipInterpolation: boolean,
		outVar: string,
		childHoist?: ChildHoistContext
	): IRNode[] {
		if (!nodes) return []
		const out: IRNode[] = []
		let i = 0
		while (i < nodes.length) {
			const node = nodes[i]

			if (hasIfAttr(node)) {
				const { nodes: chainNodes, consumed } = compileConditionalChain(
					{
						compileBranchBody: (n, skip, o) => this.compileWrapperAwareBranch(n, skip, o),
						bindingNames: this.reactiveState?.bindingNames,
					},
					this.diag,
					nodes,
					i,
					skipInterpolation,
					outVar
				)
				const ifNode = chainNodes[0]
				if (ifNode?.kind === 'If' && ifNode.reactive && this.reactiveState) {
					const bindId = childHoist?.ifHoistBindId ?? this.reactiveState.nextIfBindId()
					const anchorMode = childHoist?.ifHoistBindId != null ? 'element' : 'comment-range'
					const branches = [
						{ conditionExpr: ifNode.condition, body: ifNode.body },
						...(ifNode.elseIf ?? []).map(branch => ({
							conditionExpr: branch.condition,
							body: branch.body,
						})),
						...(ifNode.else ? [{ conditionExpr: null as string | null, body: ifNode.else }] : []),
					]
					out.push({ kind: 'ReactiveIfBind', bindId, branches, anchorMode })
					out.push({ ...ifNode, bindId, anchorMode })
				} else {
					out.push(...chainNodes)
				}
				i += consumed
				continue
			}

			out.push(...this.compileNode(node, skipInterpolation, outVar, childHoist))
			i++
		}
		return out
	}

	private compileText(
		node: any,
		skipInterpolation: boolean,
		outVar: string,
		parentHoist?: ChildHoistContext
	): IRNode[] {
		const text = node.textContent || ''
		if (!text) return []
		const reactiveBindingNames = this.reactiveState
			? parentHoist?.forBodyScopeNames
				? new Set([...this.reactiveState.bindingNames, ...parentHoist.forBodyScopeNames])
				: this.reactiveState.bindingNames
			: undefined
		if (!skipInterpolation && reactiveBindingNames) {
			this.assertInterpolationsInScope(text, reactiveBindingNames, parentHoist?.forBodyScopeNames)
		}
		if (
			!skipInterpolation &&
			this.reactiveState &&
			reactiveBindingNames &&
			textReferencesStateBindings(text, reactiveBindingNames, value =>
				tokenizeCurlyInterpolation(value, { attributeMode: false })
			)
		) {
			const bindId = parentHoist?.textHoistBindId ?? this.reactiveState.nextTextBindId()
			const readExpr = Helper.compileReactiveTextReadExpr(text)
			const interpolated = Helper.compileInterpolation(text)
			if (parentHoist?.textHoistBindId != null) {
				return [
					{ kind: 'Append', content: interpolated, outVar },
					{ kind: 'ReactiveTextBind', bindId, readExpr, anchorMode: 'element' },
				]
			}
			const content = `${emitCommentStart('text', bindId)}${interpolated}${emitCommentEnd('text', bindId)}`
			return [
				{ kind: 'Append', content, outVar },
				{ kind: 'ReactiveTextBind', bindId, readExpr, anchorMode: 'comment-range' },
			]
		}
		const content = skipInterpolation
			? Helper.escapeBackticks(text)
			: Helper.compileInterpolation(text)
		return [{ kind: 'Append', content, outVar }]
	}

	/**
	 * Lower a single element node to IR (tags + children). Uses `node.childNodes` for children;
	 * for `<template>`, wrapperless APIs in `template.ts` should be used when the tag must not
	 * appear in output.
	 */
	private compileElement(
		node: any,
		skipInterpolation: boolean,
		outVar: string,
		parentHoist?: ChildHoistContext
	): IRNode[] {
		const tagName = node.tagName.toLowerCase()
		warnWrapperlessTemplateAttributes(this.diag, node)

		if (tagName === CONST.TAG_SLOT) {
			return compileSlot(node, skipInterpolation, outVar, (nodes, skip) =>
				this.compileSlotDefaultContent(nodes, skip)
			)
		}

		if (CONST.COMPONENT_SUFFIX_REGEX.test(tagName)) {
			return this.compileComponent(node, tagName, skipInterpolation, outVar)
		}

		const {
			attrString,
			prefixContent,
			loopData,
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
		} = parseElementAttributes(
			this.resolver,
			this.diag,
			node,
			this.reactiveState ?? undefined,
			this.hypermedia
		)
		const childSkip =
			skipInterpolation || tagName === 'style' || tagName === 'script'

		if (loopData && switchExpr) {
			throw new CompileError({
				message: 'Cannot combine `switch` with `for` / `data-for` on the same element.',
				file: this.diag?.file,
			})
		}

		if (switchExpr && (hasIfAttr(node) || hasElseIfAttr(node) || hasElseAttr(node))) {
			throw new CompileError({
				message: 'Cannot combine `switch` with `if` / `else-if` / `else` on the same element.',
				file: this.diag?.file,
			})
		}

		// `case` (non-native) and misplaced `default` outside a switch are mistakes — fail loud.
		// `default` is native only on `<track>`, so a bare one there passes through untouched.
		const defaultAttr = getBuildDirectiveAttribute(node, CONST.ATTR_DEFAULT)
		const explicitDefault = defaultAttr != null && defaultAttr.name !== CONST.ATTR_DEFAULT
		const bareDefaultOnNonTrack =
			defaultAttr?.name === CONST.ATTR_DEFAULT && tagName !== 'track'
		const misplacedDefault = explicitDefault || bareDefaultOnNonTrack
		if ((hasCaseAttr(node) || misplacedDefault) && !parentIsSwitchContainer(node)) {
			throw new CompileError({
				message:
					'`case` and `default` must be direct children of an element with `switch` / `aero-switch`.',
				file: this.diag?.file,
			})
		}

		// Wrapperless `<template data-for>` / `<template for>`: body is template contents only.
		if (loopData && isTemplateElement(node)) {
			const inner = this.compileWrapperlessNode(node, childSkip, outVar, {
				forBodyScopeNames: buildForLoopBodyScopeNames(loopData.binding),
			})
			return this.wrapForLoop(loopData, inner, [
				...eventBinds,
				...textBinds,
				...busyBinds,
				...showBinds,
				...htmlBinds,
				...classBinds,
				...attributeBinds,
				...propertyBinds,
				...modelBinds,
			], undefined, 'comment-range')
		}

		if (switchExpr && isTemplateElement(node)) {
			const switchIR = compileSwitchContainer(
				{
					compileBranchBody: (n, skip, o) => this.compileWrapperAwareBranch(n, skip, o),
				},
				this.diag,
				node,
				switchExpr,
				childSkip,
				outVar
			)
			const reactive =
				this.reactiveState != null &&
				isReactiveSwitch(switchIR.expression, switchIR.cases, this.reactiveState.bindingNames)
			if (reactive && this.reactiveState) {
				const bindId = this.reactiveState.nextSwitchBindId()
				return [
					{ ...switchIR, bindId, reactive: true, anchorMode: 'comment-range' },
					{
						kind: 'ReactiveSwitchBind',
						bindId,
						expression: switchIR.expression,
						anchorMode: 'comment-range',
						cases: switchIR.cases.map(branch => ({
							comparandExprs: branch.comparandExprs,
							body: branch.body,
						})),
						...(switchIR.defaultBody !== undefined ? { defaultBody: switchIR.defaultBody } : {}),
					},
				]
			}
			return [switchIR]
		}

		if (switchExpr && CONST.VOID_TAGS.has(tagName)) {
			throw new CompileError({
				message:
					'`switch` cannot be used on a void element (no room for `case` / `default` children).',
				file: this.diag?.file,
			})
		}

		const inner: IRNode[] = []
		let switchBind: import('../ir').IRReactiveSwitchBind | null = null
		const childHoist: ChildHoistContext = {}
		if (parentHoist?.forBodyScopeNames) {
			childHoist.forBodyScopeNames = parentHoist.forBodyScopeNames
		}
		if (loopData) {
			const loopScope = buildForLoopBodyScopeNames(loopData.binding)
			childHoist.forBodyScopeNames = childHoist.forBodyScopeNames
				? new Set([...childHoist.forBodyScopeNames, ...loopScope])
				: loopScope
		}
		let reactiveSwitchBindId: number | undefined

		if (switchExpr && this.reactiveState) {
			const previewSwitch = compileSwitchContainer(
				{
					compileBranchBody: (n, skip, o) => this.compileWrapperAwareBranch(n, skip, o),
				},
				this.diag,
				node,
				switchExpr,
				childSkip,
				outVar
			)
			if (
				isReactiveSwitch(previewSwitch.expression, previewSwitch.cases, this.reactiveState.bindingNames)
			) {
				reactiveSwitchBindId = this.reactiveState.nextSwitchBindId()
			}
		}

		if (this.reactiveState && !loopData && !switchExpr) {
			const children = node.childNodes as NodeList
			const onlyEl = findOnlyElementSibling(children)
			if (onlyEl) {
				const childParsed = parseElementAttributes(
					this.resolver,
					this.diag,
					onlyEl,
					this.reactiveState,
					this.hypermedia
				)
				if (
					childParsed.loopData?.keyExpr &&
					referencesStateBindingExpression(
						childParsed.loopData.items,
						this.reactiveState.bindingNames
					)
				) {
					childHoist.forHoistBindId = this.reactiveState.nextForBindId()
				}
			}
			const ifStart = firstIfChainIndex(children)
			if (ifStart >= 0) {
				const { consumed, nodes: chainNodes } = compileConditionalChain(
					{
						compileBranchBody: (n, skip, o) => this.compileWrapperAwareBranch(n, skip, o),
						bindingNames: this.reactiveState.bindingNames,
					},
					this.diag,
					children,
					ifStart,
					skipInterpolation,
					outVar
				)
				const ifNode = chainNodes[0]
				if (
					ifNode?.kind === 'If' &&
					ifNode.reactive &&
					isOnlySiblingContent(children, ifStart, consumed)
				) {
					childHoist.ifHoistBindId = this.reactiveState.nextIfBindId()
				}
			}
			if (!childSkip) {
				let soleText: Node | null = null
				for (let ci = 0; ci < children.length; ci++) {
					const child = children[ci]!
					if (isIgnorableSibling(child)) continue
					if (child.nodeType !== 3) {
						soleText = null
						break
					}
					if (soleText) {
						soleText = null
						break
					}
					soleText = child
				}
				if (
					soleText?.textContent &&
					textReferencesStateBindings(soleText.textContent, this.reactiveState.bindingNames, value =>
						tokenizeCurlyInterpolation(value, { attributeMode: false })
					)
				) {
					childHoist.textHoistBindId = this.reactiveState.nextTextBindId()
				}
			}
		}

		if (CONST.VOID_TAGS.has(tagName)) {
			inner.push({
				kind: 'Append',
				content: `<${tagName}${attrString}>`,
				outVar,
			})
		} else {
			let openTag = `<${tagName}${attrString}>`
			if (childHoist.forHoistBindId != null) {
				openTag = injectReactiveMarkerOnOpenTag(openTag, 'for', childHoist.forHoistBindId)
			}
			if (childHoist.ifHoistBindId != null) {
				openTag = injectReactiveMarkerOnOpenTag(openTag, 'if', childHoist.ifHoistBindId)
			}
			if (childHoist.textHoistBindId != null) {
				openTag = injectReactiveMarkerOnOpenTag(openTag, 'text', childHoist.textHoistBindId)
			}
			if (reactiveSwitchBindId != null) {
				openTag = injectReactiveMarkerOnOpenTag(openTag, 'switch', reactiveSwitchBindId)
			}
			inner.push({
				kind: 'Append',
				content: openTag,
				outVar,
			})
			if (prefixContent) {
				inner.push({ kind: 'Append', content: prefixContent, outVar })
			}

			const isScript = tagName === 'script'
			const isStyle = tagName === 'style'
			let closeBlock = false

			if (isScript && passDataExpr) {
				const result = this.emitScriptPassDataIR(passDataExpr, node, outVar)
				inner.push(...result.nodes)
				closeBlock = result.closeBlock
			} else if (isStyle && passDataExpr) {
				inner.push({ kind: 'StylePassData', passDataExpr, outVar })
			}

			if (switchExpr) {
				const switchIR = compileSwitchContainer(
					{
						compileBranchBody: (n, skip, o) => this.compileWrapperAwareBranch(n, skip, o),
					},
					this.diag,
					node,
					switchExpr,
					childSkip,
					outVar
				)
				const reactive =
					this.reactiveState != null &&
					isReactiveSwitch(switchIR.expression, switchIR.cases, this.reactiveState.bindingNames)
				if (reactive && this.reactiveState && reactiveSwitchBindId != null) {
					inner.push({ ...switchIR, bindId: reactiveSwitchBindId, reactive: true, anchorMode: 'element' })
					switchBind = {
						kind: 'ReactiveSwitchBind',
						bindId: reactiveSwitchBindId,
						anchorMode: 'element',
						expression: switchIR.expression,
						cases: switchIR.cases.map(branch => ({
							comparandExprs: branch.comparandExprs,
							body: branch.body,
						})),
						...(switchIR.defaultBody !== undefined ? { defaultBody: switchIR.defaultBody } : {}),
					}
				} else {
					inner.push(switchIR)
				}
			} else {
				inner.push(...this.compileChildNodes(node.childNodes, childSkip, outVar, childHoist))
			}

			if (closeBlock) {
				inner.push({ kind: 'Append', content: '\\n}\\n', outVar })
			}

			inner.push({ kind: 'Append', content: `</${tagName}>`, outVar })
		}

		if (loopData) {
			const forHoist =
				parentHoist?.forHoistBindId != null ? { bindId: parentHoist.forHoistBindId } : undefined
			return this.wrapForLoop(
				loopData,
				inner,
				[
					...eventBinds,
					...textBinds,
					...busyBinds,
					...showBinds,
					...htmlBinds,
					...classBinds,
					...attributeBinds,
					...propertyBinds,
					...modelBinds,
					...(switchBind ? [switchBind] : []),
				],
				forHoist
			)
		}
	return [
		...inner,
		...eventBinds,
		...textBinds,
		...busyBinds,
		...showBinds,
		...htmlBinds,
		...classBinds,
		...attributeBinds,
		...propertyBinds,
		...modelBinds,
		...(switchBind ? [switchBind] : []),
	]
	}

	private emitScriptPassDataIR(
		passDataExpr: string,
		node: any,
		outVar: string
	): { nodes: IRNode[]; closeBlock: boolean } {
		const isModule = node.getAttribute('type') === 'module'
		const nodes: IRNode[] = [{ kind: 'ScriptPassData', passDataExpr, isModule, outVar }]
		return { nodes, closeBlock: !isModule }
	}

	/**
	 * Slot content must use the same sibling-based rules as {@link compileChildNodes}, including
	 * `if` / `else-if` / `else` chains. A plain `for` over `compileNode` would miss those chains
	 * (e.g. wrapperless `<template if>` inside `<base-layout>`).
	 */
	private compileSlotChildList(
		children: any[],
		skipInterpolation: boolean,
		outVar: string
	): IRNode[] {
		const slotIR: IRNode[] = []
		let i = 0
		while (i < children.length) {
			const child = children[i]
			if (child.nodeType === 1) {
				const childTagName = child.tagName?.toLowerCase()
				if (
					childTagName === CONST.TAG_SLOT &&
					child.hasAttribute(CONST.ATTR_NAME) &&
					child.hasAttribute(CONST.ATTR_SLOT)
				) {
					const passthroughName = child.getAttribute(CONST.ATTR_NAME)
					const defaultContent = this.compileSlotDefaultContent(child.childNodes, skipInterpolation)
					slotIR.push({
						kind: 'Slot',
						name: passthroughName,
						defaultContent,
						outVar,
					})
					i++
					continue
				}
			}

			if (child.nodeType === 1 && hasIfAttr(child)) {
				const parent = child.parentNode
				if (parent?.childNodes) {
					const startIndex = Array.prototype.indexOf.call(parent.childNodes as NodeList, child)
					if (startIndex >= 0) {
						const { nodes: chainNodes, consumed } = compileConditionalChain(
							{
								compileBranchBody: (n, skip, o) => this.compileWrapperAwareBranch(n, skip, o),
							},
							this.diag,
							parent.childNodes,
							startIndex,
							skipInterpolation,
							outVar
						)
						slotIR.push(...chainNodes)
						const consumedSet = new Set<unknown>()
						for (let j = startIndex; j < startIndex + consumed; j++) {
							consumedSet.add(parent.childNodes[j])
						}
						while (i < children.length && consumedSet.has(children[i])) {
							i++
						}
						continue
					}
				}
			}

			slotIR.push(...this.compileNode(child, skipInterpolation, outVar))
			i++
		}
		return slotIR
	}

	private compileComponent(
		node: any,
		tagName: string,
		skipInterpolation: boolean,
		outVar: string
	): IRNode[] {
		const kebabBase = tagName.replace(CONST.COMPONENT_SUFFIX_REGEX, '')
		const baseName = Helper.kebabToCamelCase(kebabBase)
		const isLayout = tagName.endsWith('-layout')
		const { propsString } = parseComponentAttributes(node, this.diag)
		this.validateComponentBindAttrsRequireState(node, tagName)
		const reactivePropExprs = this.collectComponentReactivePropExprs(node)
		this.validateRequiredComponentReactiveProps(tagName, kebabBase, baseName, reactivePropExprs)
		this.validateBindableComponentReactiveProps(tagName, kebabBase, baseName, reactivePropExprs)
		const componentBindId = this.reactiveState
			? this.reactiveState.nextComponentBindId()
			: undefined

		const slotVarMap: Record<string, string> = {}
		const slotContentMap: Record<string, any[]> = {
			[CONST.SLOT_NAME_DEFAULT]: [],
		}

		if (node.childNodes) {
			for (let i = 0; i < node.childNodes.length; i++) {
				const child = node.childNodes[i]
				let slotName = CONST.SLOT_NAME_DEFAULT
				if (child.nodeType === 1) {
					const slotAttr = child.getAttribute(CONST.ATTR_SLOT)
					if (slotAttr) slotName = slotAttr
				}
				slotContentMap[slotName] = slotContentMap[slotName] || []
				slotContentMap[slotName]!.push(child)
			}
		}

		const slots: Record<string, IRNode[]> = {}
		for (const [slotName, children] of Object.entries(slotContentMap)) {
			const slotVar = `__slot_${this.slotCounter++}`
			slotVarMap[slotName] = slotVar

			slots[slotName] = this.compileSlotChildList(children, skipInterpolation, slotVar)
		}

		const componentNode: IRNode = {
			kind: 'Component',
			baseName,
			propsString,
			slots,
			slotVarMap,
			componentBindId,
			isLayout,
			outVar,
		}
		if (componentBindId === undefined) return [componentNode]
		return [
			componentNode,
			{
				kind: 'ReactiveComponentBind',
				bindId: componentBindId,
				componentExpr: baseName,
				reactivePropExprs,
			},
		]
	}

	private collectComponentReactivePropExprs(node: any): Record<string, IRComponentReactivePropExpr> {
		const out: Record<string, IRComponentReactivePropExpr> = {}
		if (!this.reactiveState || !node.attributes) return out
		for (let i = 0; i < node.attributes.length; i++) {
			const attr = node.attributes[i]
			const name = String(attr.name ?? '')
			if (!name || name === CONST.ATTR_PROPS || name.startsWith(`aero-${CONST.ATTR_PROPS}`)) {
				continue
			}
			if (name.endsWith(':readonly')) {
				throw new CompileError({
					message: `Component reactive prop \`${name}\` is obsolete; use \`${name.slice(0, -':readonly'.length)}="{ ... }"\` because reactive props are readonly by default.`,
					file: this.diag?.file,
				})
			}
			const value = String(attr.value ?? '')
			const bindName = parseBindAttributePropName(name)
			if (bindName !== null && !isSingleWrappedExpression(value)) {
				throw new CompileError({
					message: `Component bind prop \`${name}\` must reference one writable state binding.`,
					file: this.diag?.file,
				})
			}
			if (!isSingleWrappedExpression(value)) continue
			const expr = Helper.stripBraces(value)
			if (bindName !== null) {
				if (!this.reactiveState.writableBindingNames.has(expr)) {
					throw new CompileError({
						message: `Component bind prop \`${name}\` must reference one writable state binding.`,
						file: this.diag?.file,
					})
				}
				out[bindName] = { expr, mutable: true }
				continue
			}
			if (!this.reactiveState.bindingNames.has(expr)) continue
			out[name] = { expr, mutable: false }
		}
		return out
	}

	private validateComponentBindAttrsRequireState(node: any, tagName: string): void {
		if (this.reactiveState || !node.attributes) return
		for (let i = 0; i < node.attributes.length; i++) {
			const attr = node.attributes[i]
			const name = String(attr.name ?? '')
			if (parseBindAttributePropName(name) == null) continue
			throw new CompileError({
				message: `Component bind prop \`${name}\` on <${tagName}> requires a writable state binding in \`<script is:state>\`.`,
				file: this.diag?.file,
			})
		}
	}

	private getComponentReactivePropMetadata(
		tagName: string,
		kebabBase: string,
		baseName: string
	): readonly ComponentReactivePropMetadata[] {
		return (
			this.componentReactiveProps[baseName] ??
			this.componentReactiveProps[kebabBase] ??
			this.componentReactiveProps[tagName] ??
			[]
		)
	}

	private validateRequiredComponentReactiveProps(
		tagName: string,
		kebabBase: string,
		baseName: string,
		reactivePropExprs: Record<string, IRComponentReactivePropExpr>
	): void {
		if (!this.reactiveState) return
		for (const prop of this.getComponentReactivePropMetadata(tagName, kebabBase, baseName)) {
			const propName = prop.propName || prop.name
			if (!prop.required || reactivePropExprs[propName] !== undefined) continue
			throw new CompileError({
				message: prop.bindable
					? `Required bindable prop \`${propName}\` for <${tagName}> must be passed with \`bind:${propName}="{ ... }"\`.`
					: `Required reactive prop \`${propName}\` for <${tagName}> must be passed as a state signal.`,
				file: this.diag?.file,
			})
		}
	}

	private validateBindableComponentReactiveProps(
		tagName: string,
		kebabBase: string,
		baseName: string,
		reactivePropExprs: Record<string, IRComponentReactivePropExpr>
	): void {
		if (!this.reactiveState) return
		const metadata = this.getComponentReactivePropMetadata(tagName, kebabBase, baseName)
		const bindablePropNames = new Set<string>()
		for (const prop of metadata) {
			if (!prop.bindable) continue
			bindablePropNames.add(prop.propName || prop.name)
			bindablePropNames.add(prop.name)
		}
		for (const [propName, passed] of Object.entries(reactivePropExprs)) {
			if (passed.mutable !== true) continue
			if (bindablePropNames.has(propName)) continue
			throw new CompileError({
				message: `Child prop \`${propName}\` for <${tagName}> must be declared with \`Aero.bindable()\` before it can be passed with \`bind:${propName}\`.`,
				file: this.diag?.file,
			})
		}
		for (const prop of metadata) {
			if (!prop.bindable) continue
			const propName = prop.propName || prop.name
			const passed = reactivePropExprs[propName]
			if (passed?.mutable === false) {
				throw new CompileError({
					message: `Bindable prop \`${propName}\` for <${tagName}> must be passed with \`bind:${propName}="{ ... }"\`.`,
					file: this.diag?.file,
				})
			}
		}
	}

	private assertInterpolationsInScope(
		text: string,
		stateBindingNames: ReadonlySet<string>,
		forBodyScopeNames?: ReadonlySet<string>
	): void {
		const allowed = new Set<string>(REACTIVE_EXPR_AMBIENT_GLOBALS)
		for (const name of stateBindingNames) allowed.add(name)
		for (const name of this.buildScopeNames) allowed.add(name)
		for (const name of forBodyScopeNames ?? []) allowed.add(name)
		for (const segment of tokenizeCurlyInterpolation(text, { attributeMode: false })) {
			if (segment.kind !== 'interpolation') continue
			const expr = segment.expression?.trim() ?? ''
			if (!expr) continue
			const undeclared = findUndeclaredReactiveIdentifiers(expr, allowed)
			if (undeclared.length === 0) continue
			const name = undeclared[0]!
			const haystack = this.diag?.source
				? this.diag.source.replace(
						/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
						match => ' '.repeat(match.length)
					)
				: undefined
			const bracedIdx = haystack ? findBracedIdentifierOffsets(haystack, name)[0] : undefined
			const nameIdx =
				bracedIdx ??
				(haystack
					? (() => {
							const m = new RegExp(
								`\\b${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\b`
							).exec(haystack)
							return m ? m.index : -1
						})()
					: -1)
			const loc =
				this.diag?.source && nameIdx >= 0
					? Helper.lineColumnAtOffset(this.diag.source, nameIdx)
					: {}
			throw new CompileError({
				message: `Unknown name \`${name}\` in reactive expression. Declare it in \`<script is:state>\` or import it.`,
				file: this.diag?.file,
				...loc,
			})
		}
	}

	private wrapForLoop(
		loopData: { binding: string; items: string; keyExpr?: string },
		body: IRNode[],
		trailing: IRNode[],
		forHoist?: { bindId: number },
		defaultAnchorMode: import('../ir').IRAnchorMode = 'comment-range'
	): IRNode[] {
		const reactive =
			this.reactiveState != null &&
			referencesStateBindingExpression(loopData.items, this.reactiveState.bindingNames)
		if (reactive && !loopData.keyExpr) {
			throw new CompileError({
				message: 'Reactive for loops require `key="{ ... }"` when the iterable references state.',
				file: this.diag?.file,
			})
		}
		const loopBody = [...body, ...trailing]
		const anchorMode = forHoist ? 'element' : defaultAnchorMode
		let forNode: IRNode = {
			kind: 'For',
			binding: loopData.binding,
			items: loopData.items,
			body: loopBody,
			...(loopData.keyExpr ? { keyExpr: loopData.keyExpr } : {}),
			...(reactive ? { reactive: true } : {}),
		}
		const nodes: IRNode[] = [forNode]
		if (reactive && this.reactiveState && loopData.keyExpr) {
			const bindId = forHoist?.bindId ?? this.reactiveState.nextForBindId()
			forNode = { ...(forNode as import('../ir').IRFor), bindId, anchorMode }
			nodes[0] = forNode
			nodes.push({
				kind: 'ReactiveForBind',
				bindId,
				anchorMode,
				binding: loopData.binding,
				bindingNames: collectForDirectiveBindingNames(
					`const ${loopData.binding} of __aeroItems`
				),
				itemsExpr: loopData.items,
				keyExpr: loopData.keyExpr,
				body: loopBody,
			})
		}
		return nodes
	}
}

function createLowererReactiveState(
	bindingNames: ReadonlySet<string>,
	writableBindingNames: ReadonlySet<string>
): LowererReactiveState {
	let textBindId = 0
	let eventBindId = 0
	let busyBindId = 0
	let componentBindId = 0
	let showBindId = 0
	let htmlBindId = 0
	let classBindId = 0
	let attributeBindId = 0
	let propertyBindId = 0
	let modelBindId = 0
	let ifBindId = 0
	let forBindId = 0
	let switchBindId = 0
	return {
		bindingNames,
		writableBindingNames,
		nextTextBindId: () => textBindId++,
		nextEventBindId: () => eventBindId++,
		nextBusyBindId: () => busyBindId++,
		nextComponentBindId: () => componentBindId++,
		nextShowBindId: () => showBindId++,
		nextHtmlBindId: () => htmlBindId++,
		nextClassBindId: () => classBindId++,
		nextAttributeBindId: () => attributeBindId++,
		nextPropertyBindId: () => propertyBindId++,
		nextModelBindId: () => modelBindId++,
		nextIfBindId: () => ifBindId++,
		nextForBindId: () => forBindId++,
		nextSwitchBindId: () => switchBindId++,
	}
}
