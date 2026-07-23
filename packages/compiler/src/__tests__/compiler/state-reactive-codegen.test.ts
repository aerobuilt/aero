import { describe, expect, it } from 'vitest'
import { compile } from '../../codegen'
import { parse } from '../../parser'

const mockOptions = {
	root: '/',
	resolvePath: (v: string, _importer: string) => v,
	importer: '/',
}

describe('state reactive codegen (PR-2d)', () => {
	it('emits mountStateBindings for reactive text interpolations', () => {
		const html = `<script is:state>
			let count = 1
			let doubled = count * 2
		</script>
		<div>{ count }-{ doubled }</div>`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain(
			"import { mountStateBindings as __aeroMountStateBindings } from '@aero-js/reactivity'"
		)
		expect(code).toContain('export function mountStateBindings(root, Aero, opts = {})')
		expect(code).toContain('data-aero-text="0"')
		expect(code).toContain('read: __aeroTextRead_0')
		expect(code).toContain('function __aeroTextRead_0(scope, escapeHtml)')
		expect(code).not.toContain('hypermediaRuntime:')
		expect(code).not.toContain('data-aero-on-click')
	})

	it('emits mountStateBindings for base on:* handlers in state scope', () => {
		const html = `<script is:state>
			let count = 1
			function inc() { count++ }
		</script>
		<button on:click="{ inc() }">{ count }</button>`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('data-aero-event="0"')
		expect(code).toContain('handler: __aeroEvent_0')
		expect(code).toContain('function __aeroEvent_0(scope, actions, event, self)')
		expect(code).toContain('event: "click"')
		expect(code).not.toContain('hypermediaRuntime:')
		expect(code).not.toContain('data-aero-on-click')
	})

	it('does not emit mountStateBindings without is:state', () => {
		const html = `<button on:click="{ alert(1) }">{ 'x' }</button>`
		const code = compile(parse(html), mockOptions)

		expect(code).not.toContain('mountStateBindings')
		expect(code).not.toContain('data-aero-text=')
		expect(code).toContain('data-aero-on-click')
	})

	it('hydration payload includes owned bindings only', () => {
		const html = `<script is:state>
			let count = 1
			let doubled = count * 2
		</script>
		<div>{ count }</div>`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('escapeScriptJson({ "count": count })')
		expect(code).not.toContain('"doubled": doubled')
		expect(code).not.toContain('"doubled":2')
	})

	it('serializes reactive props declared from Aero.props in is:state', () => {
		const html = `<script is:state>
			const { count, label = 'Counter' } = Aero.props
		</script>
		<p>{ label }: { count }</p>`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('"name":"count"')
		expect(code).toContain('reactiveProp: true')
		expect(code).toContain('required: true')
		expect(code).toContain('"name":"label"')
		expect(code).toContain('init: __aeroInit_label')
		expect(code).not.toContain('name: "label", derived: false, init: __aeroInit_label, dependencies: [], reactiveProp: true, required: true')
		expect(code).toContain('reactiveProps: opts.reactiveProps ?? {}')
		expect(code).toContain('store: opts.store ?? runtime.store')
		expect(code).not.toContain('"count": count')
		expect(code).not.toContain('"label": label')
	})

	it('exports reactive prop metadata for parent component wiring', () => {
		const html = `<script is:state>
			const { count, title: heading, label = 'Counter', value = Aero.bindable(0) } = Aero.props
		</script>
		<p>{ heading }: { label } { count } { value }</p>`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('export const __aeroReactiveProps =')
		expect(code).toContain('"name":"count"')
		expect(code).toContain('"propName":"count"')
		expect(code).toContain('required: true')
		expect(code).toContain('"name":"heading"')
		expect(code).toContain('"propName":"title"')
		expect(code).toContain('"name":"label"')
		expect(code).not.toContain('name: "label", derived: false, init: __aeroInit_label, dependencies: [], reactiveProp: true, required: true')
		expect(code).toContain('"name":"value"')
		expect(code).toContain('"bindable":true')
	})

	it('emits component bind records for reactive parent component instances', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component count="{ count }" label="Static" />`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('data-aero-component="0"')
		expect(code).toContain('componentBinds:')
		expect(code).toContain('component: counter')
		expect(code).toContain('reactivePropExprs: {"count":{"expr":"count","mutable":false}}')
	})

	it('emits mutable component reactive prop records for bind syntax', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component bind:count="{ count }" />`

		const code = compile(parse(html), {
			...mockOptions,
			componentReactiveProps: {
				counter: [{ name: 'count', propName: 'count', required: false, bindable: true }],
			},
		})

		expect(code).toContain('reactivePropExprs: {"count":{"expr":"count","mutable":true}}')
		expect(code).toContain('renderComponent(counter, { "count": count }')
		expect(code).not.toContain('"bind:count"')
	})

	it('injects layout component bind on html instead of span wrapper', () => {
		const html = `<script is:build>
			import base from '@layouts/base.html'
		</script>
		<script is:state>
			let count = 0
		</script>
		<base-layout count="{ count }">
			<p>{ count }</p>
		</base-layout>`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('__aero_layout_0.replace(/<html\\b/i')
		expect(code).toContain('data-aero-component="0"')
		expect(code).not.toMatch(/<span data-aero-component="0">/)
	})

	it('emits component bind records for reactive parent components without reactive props', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component label="Static" />`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('data-aero-component="0"')
		expect(code).toContain('componentBinds:')
		expect(code).toContain('component: counter')
		expect(code).toContain('reactivePropExprs: {}')
	})

	it('emits component module refs for imported components with reactive props', () => {
		const html = `<script is:build>
			import header from '@components/header.html'
		</script>
		<script is:state>
			let count = 1
		</script>
		<header-component count="{ count }" />`

		const code = compile(parse(html), mockOptions)

		expect(code).toContain('const __aeroMod_header = await import')
		expect(code).toContain('const header = __aeroMod_header.default')
		expect(code).toContain('component: __aeroMod_header')
	})

	it('rejects bind component props that do not reference writable parent state', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
			let doubled = count * 2
		</script>
		<counter-component bind:count="{ doubled }" />`

		expect(() => compile(parse(html), mockOptions)).toThrow(
			'Component bind prop `bind:count` must reference one writable state binding.'
		)
	})

	it('rejects bind component props without a parent state scope', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<counter-component bind:count="{ count }" />`

		expect(() => compile(parse(html), mockOptions)).toThrow(
			'Component bind prop `bind:count` on <counter-component> requires a writable state binding in `<script is:state>`.'
		)
	})

	it('rejects omitted required child reactive props when component metadata is available', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component label="Static" />`

		expect(() =>
			compile(parse(html), {
				...mockOptions,
				componentReactiveProps: {
					counter: [{ name: 'count', propName: 'count', required: true }],
				},
			})
		).toThrow(
			'Required reactive prop `count` for <counter-component> must be passed as a state signal.'
		)
	})

	it('rejects bind component props when the child prop is not bindable', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component bind:count="{ count }" />`

		expect(() =>
			compile(parse(html), {
				...mockOptions,
				componentReactiveProps: {
					counter: [{ name: 'count', propName: 'count', required: true }],
				},
			})
		).toThrow(
			'Child prop `count` for <counter-component> must be declared with `Aero.bindable()` before it can be passed with `bind:count`.'
		)
	})

	it('rejects bind component props when the child has no reactive prop metadata', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component bind:count="{ count }" />`

		expect(() => compile(parse(html), mockOptions)).toThrow(
			'Child prop `count` for <counter-component> must be declared with `Aero.bindable()` before it can be passed with `bind:count`.'
		)
	})

	it('rejects bind component props when the bind name is not a known bindable child prop', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component bind:count="{ count }" />`

		expect(() =>
			compile(parse(html), {
				...mockOptions,
				componentReactiveProps: {
					counter: [{ name: 'value', propName: 'value', required: false, bindable: true }],
				},
			})
		).toThrow(
			'Child prop `count` for <counter-component> must be declared with `Aero.bindable()` before it can be passed with `bind:count`.'
		)
	})

	it('allows bind component props when the child prop is bindable', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component bind:count="{ count }" />`

		expect(() =>
			compile(parse(html), {
				...mockOptions,
				componentReactiveProps: {
					counter: [{ name: 'count', propName: 'count', required: false, bindable: true }],
				},
			})
		).not.toThrow()
	})

	it('rejects plain reactive props when the child declares them bindable', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component count="{ count }" />`

		expect(() =>
			compile(parse(html), {
				...mockOptions,
				componentReactiveProps: {
					counter: [{ name: 'count', propName: 'count', required: false, bindable: true }],
				},
			})
		).toThrow(
			'Bindable prop `count` for <counter-component> must be passed with `bind:count="{ ... }"`.'
		)
	})

	it('rejects omitted required bindable props with bind: messaging', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component label="Static" />`

		expect(() =>
			compile(parse(html), {
				...mockOptions,
				componentReactiveProps: {
					counter: [{ name: 'count', propName: 'count', required: true, bindable: true }],
				},
			})
		).toThrow(
			'Required bindable prop `count` for <counter-component> must be passed with `bind:count="{ ... }"`.'
		)
	})

	it('rejects obsolete readonly component reactive prop syntax', () => {
		const html = `<script is:build>
			const counter = { name: 'counter' }
		</script>
		<script is:state>
			let count = 1
		</script>
		<counter-component count:readonly="{ count }" />`

		expect(() => compile(parse(html), mockOptions)).toThrow(
			'Component reactive prop `count:readonly` is obsolete; use `count="{ ... }"` because reactive props are readonly by default.'
		)
	})

	it('collects reactive binds inside switch branches with is:state', () => {
		const html = `<script is:state>
			const auth = { state: 'SignedOut' }
		</script>
		<div switch="{ auth.state }">
			<span case="SignedIn">{ auth.state }</span>
			<span default>Default</span>
		</div>`

		expect(() => compile(parse(html), mockOptions)).not.toThrow()
	})

	it('passes is:state imports into mount scopeConstants', () => {
		const html = `<script is:state>
			import { AuthState } from '@shared/types/auth'
			let authState = AuthState.SignedOut
			function toggleAuth() {
				authState = authState === AuthState.SignedIn ? AuthState.SignedOut : AuthState.SignedIn
			}
		</script>
		<a on:click="{ toggleAuth() }">{ authState === AuthState.SignedIn ? 'Log Out' : 'Log In' }</a>`

		const code = compile(parse(html), mockOptions)
		expect(code).toContain('scopeConstants: { AuthState: AuthState }')
	})

	it('includes hypermedia runtime wiring when hypermedia: true', () => {
		const html = `<script is:state>
			let count = 1
		</script>
		<div>{ count }</div>`

		const code = compile(parse(html), { ...mockOptions, hypermedia: true })
		expect(code).toContain('hypermediaRuntime: Aero.getHypermediaRuntime?.() ?? undefined')
		expect(code).not.toContain('import { POST, GET, PUT, PATCH, DELETE }')
	})

	it('emits mountStateBindings for top-level $effect', () => {
		const html = `<script is:state>
			let count = 0
			$effect(() => { count })
		</script>`

		const code = compile(parse(html), { ...mockOptions, reactivity: true })

		expect(code).toContain("Effect as __aeroEffect } from '@aero-js/reactivity'")
		expect(code).toContain('function __aeroEffect_0(scope)')
		expect(code).toContain('effectRuns: [__aeroEffect_0]')
		expect(code).toContain('export function mountStateBindings(root, Aero, opts = {})')
	})

	it('emits $effect-only pages without markup binds', () => {
		const html = `<script is:state>
			let value = 1
			$effect(() => { value })
		</script>`

		const code = compile(parse(html), { ...mockOptions, reactivity: true })

		expect(code).toContain('effectRuns: [__aeroEffect_0]')
		expect(code).not.toContain('data-aero-text=')
	})

	it('strips $effect from SSR state script body', () => {
		const html = `<script is:state>
			let count = 0
			$effect(() => { count })
		</script>`

		const code = compile(parse(html), { ...mockOptions, reactivity: true })

		expect(code).toContain('let count = 0')
		expect(code).not.toContain('$effect(()')
	})
})
