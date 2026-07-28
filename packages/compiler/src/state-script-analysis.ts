import { parseSync } from 'oxc-parser'
import {
	collectReadonlyReactivePropWrites,
	readonlyReactivePropWriteMessage,
} from './readonly-reactive-prop-writes'

export interface StateBinding {
	name: string
	derived: boolean
	dependencies: string[]
	initExpr: string
	reactiveProp?: boolean
	propName?: string
	required?: boolean
	bindable?: boolean
	writes?: boolean
}

export interface StateEffectBinding {
	id: number
	/** Inner body of the callback passed to `$effect` / `Aero.effect`. */
	bodySource: string
	isBlockBody: boolean
}

export interface StateScriptDiagnostic {
	message: string
	name: string
	range?: [number, number]
}

export interface StateScriptAnalysisResult {
	bindings: StateBinding[]
	effects: StateEffectBinding[]
	diagnostics: StateScriptDiagnostic[]
}

const STATE_SCRIPT_FILENAME = 'state.ts'
const STATE_SCRIPT_PARSE_OPTIONS = {
	sourceType: 'module',
	range: true,
	lang: 'ts',
} as const

function walkStateScriptAst(node: unknown, visit: (node: any) => void): void {
	if (!node || typeof node !== 'object') return
	visit(node)
	for (const value of Object.values(node as Record<string, unknown>)) {
		if (!value) continue
		if (Array.isArray(value)) {
			for (const item of value) walkStateScriptAst(item, visit)
			continue
		}
		if (typeof value === 'object') walkStateScriptAst(value, visit)
	}
}

function collectIdentifiersFromInit(initNode: unknown): Set<string> {
	const names = new Set<string>()
	walkStateScriptAst(initNode, node => {
		if (node?.type === 'Identifier' && typeof node.name === 'string') {
			names.add(node.name)
		}
	})
	return names
}

function topLevelVariableDeclarators(
	program: any
): Array<{ id: any; init: any; range?: [number, number]; kind: 'const' | 'let' | 'var' }> {
	const out: Array<{ id: any; init: any; range?: [number, number]; kind: 'const' | 'let' | 'var' }> = []
	for (const stmt of program?.body ?? []) {
		let declaration = stmt
		if (stmt?.type === 'ExportNamedDeclaration' && stmt.declaration) declaration = stmt.declaration
		if (declaration?.type !== 'VariableDeclaration') continue
		const kind = declaration.kind as 'const' | 'let' | 'var'
		for (const d of declaration.declarations ?? []) {
			out.push({ id: d.id, init: d.init, range: d.range, kind })
		}
	}
	return out
}

function isFunctionInitializer(init: unknown): boolean {
	const expr = unwrapExpression(init as { type?: string; expression?: unknown })
	return expr?.type === 'ArrowFunctionExpression' || expr?.type === 'FunctionExpression'
}

function initExprSource(script: string, init: unknown): string {
	if (!init || typeof init !== 'object') return 'undefined'
	const node = init as { start?: number; end?: number }
	if (typeof node.start !== 'number' || typeof node.end !== 'number') return 'undefined'
	return script.slice(node.start, node.end)
}

function unwrapExpression(node: any): any {
	let current = node
	while (
		current?.type === 'TSAsExpression' ||
		current?.type === 'TSSatisfiesExpression' ||
		current?.type === 'TSNonNullExpression'
	) {
		current = current.expression
	}
	return current
}

function isAeroPropsExpression(node: unknown): boolean {
	const expr = unwrapExpression(node as any)
	return (
		expr?.type === 'MemberExpression' &&
		expr.object?.type === 'Identifier' &&
		expr.object.name === 'Aero' &&
		expr.property?.type === 'Identifier' &&
		expr.property.name === 'props' &&
		expr.computed === false
	)
}

function isAeroBindableCall(node: unknown): boolean {
	const expr = unwrapExpression(node as any)
	return (
		expr?.type === 'CallExpression' &&
		expr.callee?.type === 'MemberExpression' &&
		expr.callee.object?.type === 'Identifier' &&
		expr.callee.object.name === 'Aero' &&
		expr.callee.property?.type === 'Identifier' &&
		expr.callee.property.name === 'bindable' &&
		expr.callee.computed === false
	)
}

function bindableFallbackExprSource(script: string, call: any): string {
	const firstArg = call?.arguments?.[0]
	if (!firstArg) return 'undefined'
	const expr = firstArg.expression ?? firstArg
	return initExprSource(script, expr)
}

function propertyKeyName(property: any): string | null {
	const key = property?.key
	if (key?.type === 'Identifier') return key.name
	if (key?.type === 'Literal' && typeof key.value === 'string') return key.value
	return null
}

function reactivePropBindingFromProperty(
	script: string,
	property: any
): StateBinding | null {
	if (property?.type !== 'Property') return null
	if (property.computed) return null
	const propName = propertyKeyName(property)
	if (!propName) return null

	const value = property.value
	if (value?.type === 'Identifier') {
		return {
			name: value.name,
			propName,
			derived: false,
			dependencies: [],
			initExpr: 'undefined',
			reactiveProp: true,
			required: true,
		}
	}
	if (value?.type === 'AssignmentPattern' && value.left?.type === 'Identifier') {
		const bindableCall = isAeroBindableCall(value.right) ? unwrapExpression(value.right) : null
		const bindable = bindableCall != null
		const hasBindableFallback = Boolean(bindableCall?.arguments?.[0])
		return {
			name: value.left.name,
			propName,
			derived: false,
			dependencies: [],
			initExpr: bindable
				? bindableFallbackExprSource(script, bindableCall)
				: initExprSource(script, value.right),
			reactiveProp: true,
			required: bindable ? !hasBindableFallback : false,
			...(bindable ? { bindable: true } : {}),
		}
	}
	return null
}

function reactivePropBindingsFromDeclarator(script: string, declarator: { id: any; init: any }): StateBinding[] {
	if (declarator.id?.type !== 'ObjectPattern') return []
	if (!isAeroPropsExpression(declarator.init)) return []
	const out: StateBinding[] = []
	for (const property of declarator.id.properties ?? []) {
		const binding = reactivePropBindingFromProperty(script, property)
		if (binding) out.push(binding)
	}
	return out
}

function isEffectCallee(node: unknown): boolean {
	const expr = unwrapExpression(node as any)
	if (expr?.type === 'Identifier' && expr.name === '$effect') return true
	return (
		expr?.type === 'MemberExpression' &&
		expr.object?.type === 'Identifier' &&
		expr.object.name === 'Aero' &&
		expr.property?.type === 'Identifier' &&
		expr.property.name === 'effect' &&
		expr.computed === false
	)
}

function isTopLevelEffectStatement(program: any, callNode: any): boolean {
	for (const stmt of program?.body ?? []) {
		if (stmt?.type !== 'ExpressionStatement') continue
		const call = unwrapExpression(stmt.expression)
		if (call === callNode) return true
	}
	return false
}

function effectBindingFromCall(
	script: string,
	call: any,
	id: number
): { binding: StateEffectBinding | null; diagnostic?: StateScriptDiagnostic } {
	const args = call.arguments ?? []
	if (args.length !== 1) {
		return {
			binding: null,
			diagnostic: {
				name: '$effect',
				message: '`$effect` requires exactly one function argument.',
				range: call.range,
			},
		}
	}
	const callback = unwrapExpression(args[0])
	if (
		callback?.type !== 'ArrowFunctionExpression' &&
		callback?.type !== 'FunctionExpression'
	) {
		return {
			binding: null,
			diagnostic: {
				name: '$effect',
				message: '`$effect` requires a function argument.',
				range: call.range,
			},
		}
	}
	const body = callback.body
	if (!body || typeof body.start !== 'number' || typeof body.end !== 'number') {
		return {
			binding: null,
			diagnostic: {
				name: '$effect',
				message: '`$effect` callback must have a body.',
				range: call.range,
			},
		}
	}
	if (body.type === 'BlockStatement') {
		return {
			binding: {
				id,
				bodySource: script.slice(body.start + 1, body.end - 1),
				isBlockBody: true,
			},
		}
	}
	return {
		binding: {
			id,
			bodySource: script.slice(body.start, body.end),
			isBlockBody: false,
		},
	}
}

function collectStateEffects(
	script: string,
	program: any,
	diagnostics: StateScriptDiagnostic[]
): StateEffectBinding[] {
	const effects: StateEffectBinding[] = []
	let nextId = 0

	for (const stmt of program?.body ?? []) {
		let declaration = stmt
		if (stmt?.type === 'ExportNamedDeclaration' && stmt.declaration) declaration = stmt.declaration
		if (declaration?.type === 'VariableDeclaration') {
			for (const declarator of declaration.declarations ?? []) {
				const init = unwrapExpression(declarator.init)
				if (init?.type === 'CallExpression' && isEffectCallee(init.callee)) {
					diagnostics.push({
						name: '$effect',
						message: '`$effect` cannot be assigned; call it as a top-level statement.',
						range: declarator.range ?? init.range,
					})
				}
			}
		}
	}

	for (const stmt of program?.body ?? []) {
		if (stmt?.type !== 'ExpressionStatement') continue
		const call = unwrapExpression(stmt.expression)
		if (call?.type !== 'CallExpression' || !isEffectCallee(call.callee)) continue
		const result = effectBindingFromCall(script, call, nextId)
		if (result.diagnostic) diagnostics.push(result.diagnostic)
		if (result.binding) {
			effects.push(result.binding)
			nextId++
		}
	}

	walkStateScriptAst(program, node => {
		if (node?.type !== 'CallExpression' || !isEffectCallee(node.callee)) return
		if (isTopLevelEffectStatement(program, node)) return
		diagnostics.push({
			name: '$effect',
			message: '`$effect` must be called at the top level of `<script is:state>`.',
			range: node.range,
		})
	})

	return effects
}

/** Remove top-level `$effect` / `Aero.effect` calls from state script source (mount-only; not SSR). */
export function stripStateEffectStatements(script: string): string {
	if (!script.trim()) return script

	const parsed = parseSync(STATE_SCRIPT_FILENAME, script, STATE_SCRIPT_PARSE_OPTIONS)
	if (parsed.errors.length > 0) return script

	const ranges: Array<[number, number]> = []
	for (const stmt of (parsed.program as { body?: unknown[] }).body ?? []) {
		const node = stmt as {
			type?: string
			start?: number
			end?: number
			expression?: unknown
		}
		if (node.type !== 'ExpressionStatement') continue
		const call = unwrapExpression(node.expression)
		if (call?.type !== 'CallExpression' || !isEffectCallee(call.callee)) continue
		if (typeof node.start !== 'number' || typeof node.end !== 'number') continue
		ranges.push([node.start, node.end])
	}

	if (ranges.length === 0) return script

	let out = script
	for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
		out = out.slice(0, start) + out.slice(end)
	}
	return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function analyzeStateScript(script: string): StateScriptAnalysisResult {
	if (!script.trim()) {
		return { bindings: [], effects: [], diagnostics: [] }
	}

	const parsed = parseSync(STATE_SCRIPT_FILENAME, script, STATE_SCRIPT_PARSE_OPTIONS)
	if (parsed.errors.length > 0) {
		const first = parsed.errors[0]
		throw new Error(
			`[aero] State script parse error: ${first.message}${first.codeframe ? '\n' + first.codeframe : ''}`
		)
	}

	const declarators = topLevelVariableDeclarators(parsed.program)
	const reactivePropBindings = declarators.flatMap(d => reactivePropBindingsFromDeclarator(script, d))
	const writableStateNames = new Set<string>()
	for (const d of declarators) {
		if (d.id?.type === 'Identifier' && typeof d.id.name === 'string') {
			if (d.kind === 'let' || d.kind === 'var') writableStateNames.add(d.id.name)
		}
	}

	const bindings: StateBinding[] = [...reactivePropBindings]
	for (const d of declarators) {
		if (d.id?.type !== 'Identifier' || typeof d.id.name !== 'string') continue
		if (d.kind === 'const' && isFunctionInitializer(d.init)) continue
		const deps = [...collectIdentifiersFromInit(d.init)].filter(dep => writableStateNames.has(dep))
		bindings.push({
			name: d.id.name,
			derived: deps.length > 0,
			dependencies: deps,
			initExpr: initExprSource(script, d.init),
		})
	}

	const derived = new Set(bindings.filter(b => b.derived).map(b => b.name))
	const diagnostics: StateScriptDiagnostic[] = []
	const effects = collectStateEffects(script, parsed.program, diagnostics)
	const reactivePropNames = new Set(reactivePropBindings.map(binding => binding.name))
	const reactivePropNameToPropName = new Map(
		reactivePropBindings.map(binding => [binding.name, binding.propName ?? binding.name])
	)
	const bindableReactivePropNames = new Set(
		reactivePropBindings.filter(binding => binding.bindable).map(binding => binding.name)
	)
	const ownedNames = new Set(bindings.filter(binding => !binding.reactiveProp).map(binding => binding.name))
	const writtenReactiveProps = new Set<string>()
	for (const name of reactivePropNames) {
		if (ownedNames.has(name)) {
			diagnostics.push({
				name,
				message: `Reactive prop \`${name}\` conflicts with an owned state binding.`,
			})
		}
	}

	for (const write of collectReadonlyReactivePropWrites(parsed.program, new Set([...reactivePropNames].filter(name => !bindableReactivePropNames.has(name))))) {
		const propName = reactivePropNameToPropName.get(write.name) ?? write.name
		diagnostics.push({
			name: write.name,
			message: readonlyReactivePropWriteMessage(propName),
			range: write.range,
		})
	}

	walkStateScriptAst(parsed.program, node => {
		if (node?.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
			const name = node.left.name
			if (reactivePropNames.has(name)) writtenReactiveProps.add(name)
			if (derived.has(name)) {
				diagnostics.push({
					name,
					message: `Derived state \`${name}\` is read-only and cannot be assigned.`,
					range: node.range,
				})
			}
		}
		if (node?.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
			const name = node.argument.name
			if (reactivePropNames.has(name)) writtenReactiveProps.add(name)
			if (derived.has(name)) {
				diagnostics.push({
					name,
					message: `Derived state \`${name}\` is read-only and cannot be updated.`,
					range: node.range,
				})
			}
		}
	})
	for (const binding of bindings) {
		if (binding.reactiveProp && writtenReactiveProps.has(binding.name)) {
			binding.writes = true
		}
	}

	return {
		bindings,
		effects,
		diagnostics,
	}
}
