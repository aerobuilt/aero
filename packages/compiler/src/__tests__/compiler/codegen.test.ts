/**
 * Unit tests for the Aero codegen (codegen.ts): compile(parse(html)) → async render function.
 *
 * Covers interpolation, for, components (props, aero-props, slots), if/else-if/else,
 * getStaticPaths extraction, props (client/inline/blocking/style), client script injection,
 * Alpine/HTMX attribute preservation. Uses an execute()
 * helper that evals the generated module body with a mock Aero context.
 */

import { describe, it, expect } from 'vitest'
import { parse } from '../../parser'
import { compile } from '../../codegen'
import { getRenderComponentContextArg, escapeHtml, escapeScriptJson, raw, trim, trimStart, trimEnd } from '../../helpers'
import { analyzeBuildScript } from '../../build-script-analysis'

/** Runs the generated render function: finds export default async function(Aero) body and executes it with the given context. */
async function execute(code: string, context: Record<string, any> = {}) {
	// Generate the wrapper function
	// We expect the code to contain `export default async function(Aero) { ... }`
	// and optionally a preceding `export ... function getStaticPaths(...) { ... }`

	// Find the render function (export default)
	const defaultIdx = code.indexOf('export default async function')
	const renderCode = defaultIdx >= 0 ? code.slice(defaultIdx) : code

	// Robust replacement: find the function body
	const bodyStart = renderCode.indexOf('{')
	const bodyEnd = renderCode.lastIndexOf('}')
	const body = renderCode.substring(bodyStart + 1, bodyEnd)

	// Create an actual AsyncFunction
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
	const renderFn = new AsyncFunction('Aero', body)

	const aeroContext = {
		scripts: new Set<string>(),
		headScripts: new Set<string>(),
		styles: new Set<string>(),
		renderComponent: async () => '',
		page: {
			url: new URL('http://localhost'),
			request: new Request('http://localhost'),
			params: {},
		},
		site: { url: '' },
		slots: {},
		props: {},
		escapeHtml,
		escapeScriptJson,
		raw,
		trim,
		trimStart,
		trimEnd,
		...context,
	}
	return await renderFn(aeroContext)
}

const mockOptions = {
	root: '/',
	resolvePath: (v: string, _importer: string) => v,
	importer: '/',
}

describe('Codegen', () => {
	it('should auto-escape HTML in interpolations', async () => {
		const html = `<script is:build>
										const name = '<b>bold</b>';
									</script>
									<h1>{ name }</h1>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<h1>&lt;b&gt;bold&lt;/b&gt;</h1>')
	})

	it('should render entity-encoded script snippets inside code as text, not script elements', async () => {
		const html = `<script is:build></script>
<p>in <code>&lt;script is:build&gt;</code> end</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)
		const output = await execute(code)

		expect(output).toContain('&lt;script is:build&gt;')
		expect(output).not.toMatch(/<code><script[^>]*is:build/)
	})

	it('should support raw() to bypass escaping', async () => {
		const html = `<script is:build>
										const html = '<b>bold</b>';
									</script>
									<h1>{ raw(html) }</h1>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<h1><b>bold</b></h1>')
	})

	it('should support trim helpers in interpolations', async () => {
		const html = `<script is:build>
										const text = '  hello  ';
									</script>
									<p>{ trim(text) }|{ trimStart(text) }|{ trimEnd(text) }</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)
		const output = await execute(code)
		expect(output).toContain('<p>hello|hello  |  hello</p>')
	})

	it('should provide loop metadata (index, first, last, length)', async () => {
		const html = `<script is:build>
										const items = ['a', 'b', 'c'];
									</script>
									<ul>
										<li for="{ const item of items }">
											{ item }-{ index }-{ first }-{ last }-{ length }
										</li>
									</ul>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('a-0-true-false-3')
		expect(output).toContain('b-1-false-false-3')
		expect(output).toContain('c-2-false-true-3')
	})

	it('should compile simple interpolation', async () => {
		const html = `<script is:build>
										title = 'Hello World';
									</script>
									<h1>{ title }</h1>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<h1>Hello World</h1>')
	})

	it('should compile attribute interpolation', async () => {
		const html = `<script is:build>
										const cls = 'active';
									</script>
									<div class="{ cls }"></div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<div class="active"></div>')
	})

	it('should compile nested braces in text as single interpolation', async () => {
		const html = `<script is:build>
										const obj = { label: 'Nested' };
										const fn = (x) => x.label;
									</script>
									<p>{ fn({ label: obj.label }) }</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<p>Nested</p>')
	})

	it('should compile nested braces in attribute as single interpolation', async () => {
		const html = `<script is:build>
										const getVal = (x) => x.v;
									</script>
									<div title="{ getVal({ v: 'ok' }) }"></div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('title="ok"')
	})

	it('should handle missing script', async () => {
		const html = '<div>Static</div>'

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toBe('<div>Static</div>')
	})

	it('should compile for loops', async () => {
		const html = `<script is:build>
										const items = ['a', 'b'];
									</script>
									<ul>
										<li for="{ const item of items }">{ item }</li>
									</ul>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		// Normalize whitespace for easier comparison if needed, but contain should work
		expect(output).toContain('<li>a</li>')
		expect(output).toContain('<li>b</li>')
		expect(output).not.toContain('for')
	})

	it('should compile wrapperless template for (children only, no template tag)', async () => {
		const html = `<script is:build>
										const items = ['a', 'b'];
									</script>
									<ul>
										<template for="{ const item of items }">
											<li>{ item }</li>
										</template>
									</ul>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<li>a</li>')
		expect(output).toContain('<li>b</li>')
		expect(output).not.toMatch(/<template[\s>]/i)
		expect(output).not.toContain('for')
	})

	it('should compile wrapperless template for alias (for=)', async () => {
		const html = `<script is:build>
										const items = [1, 2];
									</script>
									<div>
										<template for="{ const n of items }"><span>{ n }</span></template>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<span>1</span>')
		expect(output).toContain('<span>2</span>')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should compile wrapperless template for inside component default slot', async () => {
		const html = `<script is:build>
										const items = ['x', 'y'];
										const layout = { name: 'layout' };
									</script>
									<layout-component>
										<template for="{ const item of items }">
											<p>{ item }</p>
										</template>
									</layout-component>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const Aero = {
			renderComponent: async (_comp: any, _props: any, slots: any) => slots.default ?? '',
		}

		const output = await execute(code, Aero)
		expect(output).toContain('<p>x</p>')
		expect(output).toContain('<p>y</p>')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should compile switch on a div (preserved wrapper, case/default)', async () => {
		const html = `<script is:build>
										const state = 'ready';
									</script>
									<div>
										<section class="panel" switch="{ state }">
											<p case="loading">Loading</p>
											<p case="ready">Ready</p>
											<p default>Other</p>
										</section>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<section class="panel">')
		expect(output).toContain('<p>Ready</p>')
		expect(output).not.toContain('Loading')
		expect(output).not.toContain('Other')
		expect(output).not.toContain('switch')
		expect(output).not.toContain('case=')
	})

	it('should compile wrapperless template switch', async () => {
		const html = `<script is:build>
										const tab = 'settings';
									</script>
									<div>
										<template switch="{ tab }">
											<section case="overview">Overview</section>
											<section case="settings">Settings</section>
											<section default>Fallback</section>
										</template>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Settings')
		expect(output).not.toContain('Overview')
		expect(output).not.toContain('Fallback')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should compile grouped case values', async () => {
		const html = `<script is:build>
										const status = 'queued';
									</script>
									<div>
										<div switch="{ status }">
											<span case="{ ['active', 'queued'] }">Visible</span>
											<span case="archived">Archived</span>
											<span default>Unknown</span>
										</div>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Visible')
		expect(output).not.toContain('Archived')
		expect(output).not.toContain('Unknown')
	})

	it('should compile switch inside component default slot', async () => {
		const html = `<script is:build>
										const mode = 'b';
										const shell = { name: 'shell' };
									</script>
									<shell-component>
										<div switch="{ mode }">
											<span case="a">A</span>
											<span case="b">B</span>
										</div>
									</shell-component>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const Aero = {
			renderComponent: async (_c: any, _p: any, slots: any) => slots.default ?? '',
		}

		const output = await execute(code, Aero)
		expect(output).toContain('B')
		expect(output).not.toContain('A')
	})

	it('should throw when for value is not brace-wrapped', async () => {
		const html = `<script is:build>
										const items = ['a', 'b'];
									</script>
									<ul>
										<li for="const item of items">{ item }</li>
									</ul>`

		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(
			'Directive `for` on <li> must use a braced expression'
		)
	})

	it('should resolve component tags', async () => {
		const html = `<script is:build>
										const myComp = { name: 'my-comp' };
									</script>
									<my-comp-component />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		// Mock Aero context with renderComponent
		const Aero = {
			renderComponent: async (comp: any, _props: any) => {
				return `<div class="mock-rendered">${comp.name}</div>`
			},
		}

		const output = await execute(code, Aero)
		expect(output).toContain('<div class="mock-rendered">my-comp</div>')
		expect(output).not.toContain('<my-comp-component')
	})

	it('should pass props and support shorthand', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
										const someProps = { title: 'External' };
										const props = { theme: 'dark' };
									</script>
									<my-comp-component
										title="Local" item="{ 'a' }"
										aero-props="{ ...someProps }" />
									<my-comp-component aero-props />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)

		// First call: { ...someProps, title: "Local", item: 'a' }
		expect(renderedProps[0]).toEqual({ title: 'Local', item: 'a' })
		// Second call (shorthand): { ...props } -> { theme: 'dark' }
		expect(renderedProps[1]).toEqual({ theme: 'dark' })
	})

	it('should interpolate mixed component prop strings', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
										const slug = 'docs-1';
									</script>
									<my-comp-component title="Slug: { slug }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ title: 'Slug: docs-1' })
	})

	it('should support multiple interpolations in a component prop string', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
										const section = 'docs';
										const slug = 'intro';
									</script>
									<my-comp-component title="{ section }/{ slug }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ title: 'docs/intro' })
	})

	it('should keep full braced component prop expressions as typed values', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
									</script>
									<my-comp-component count="{ 2 * 21 }" enabled="{ true }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ count: 42, enabled: true })
	})

	it('should allow hyphenated component prop names', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
									</script>
									<my-comp-component aria-label="Greeting" data-test-id="{ 'abc-123' }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (_comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ 'aria-label': 'Greeting', 'data-test-id': 'abc-123' })
	})

	it('should preserve backticks in single braced component prop expressions', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
									</script>
									<my-comp-component title="{ \`Hello\` }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (_comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ title: 'Hello' })
	})

	it('should support literal braces in component prop strings via string expressions', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
										const slug = 'intro';
									</script>
									<my-comp-component title="{ '{ slug } + ' + slug }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ title: '{ slug } + intro' })
	})

	it('should support default and named slots', async () => {
		const html = `<script is:build>
										const base = { name: 'base' };
										const nav = { name: 'nav' };
									</script>
									<base-layout>
										<nav-component slot="nav" />
										<h1>Main Content</h1>
									</base-layout>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const calls: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any, slots: any) => {
				calls.push({ comp, slots })
				return comp.name || ''
			},
		}

		await execute(code, Aero)

		const baseCall = calls.find(c => c.comp.name === 'base')
		expect(baseCall.slots.nav).toContain('nav')
		expect(baseCall.slots.default).toContain('<h1>Main Content</h1>')
	})

	it('should transform static imports to dynamic imports', async () => {
		const html = `<script is:build>
										import { foo } from './fake-module'
										const res = foo;
									</script>
									<div>{ res }</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		expect(code).toContain('await import')
		expect(code).toContain('foo')
		expect(code).toMatch(/const\s*\{\s*foo\s*\}\s*=\s*await import\([^)]+\)/)
		expect(code).not.toContain('import { foo } from')
	})

	it('should allow is:inline scripts and leave them in place', async () => {
		const html = `<script is:inline>console.log('inline');</script>
									<div>Content</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain("<script>console.log('inline');</script>")
		expect(output).toContain('<div>Content</div>')
	})

	it('should support props on is:inline scripts', async () => {
		const html = `<script is:build>
									const config = { theme: 'dark', id: 42 };
								</script>
								<script is:inline props="{ config }">
									console.log(config.theme);
								</script>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('const config = {"theme":"dark","id":42};')
		expect(output).toContain('console.log(config.theme);')
	})

	it('should not HTML-escape is:inline script body when props are used', async () => {
		const html = `<script is:build>
			const flag = true;
		</script>
		<script is:inline props="{ flag }">
			console.debug('[aero]', flag)
		</script>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)
		const output = await execute(code)

		expect(output).toContain("console.debug('[aero]', flag)")
		expect(output).not.toContain('&#39;')
		expect(output).not.toContain('&amp;')
	})

	it('should handle attributes with colons (Alpine.js style)', async () => {
		const html = '<button :disabled="!message.length">{ Aero.label }</button>'

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code, { label: 'Click' })
		expect(output).toContain(':disabled="!message.length"')
		expect(output).toContain('Click')
	})

	it('should support Aero.page.url, Aero.page.params, Aero.site.url', async () => {
		const html = `<script is:build></script>
			<p>url: { Aero.page.url.href }</p>
			<p>slug: { Aero.page.params.slug }</p>
			<p>site: { Aero.site.url }</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code, {
			page: {
				url: new URL('http://localhost/docs/intro'),
				request: new Request('http://localhost/docs/intro'),
				params: { slug: 'intro' },
			},
			site: { url: 'https://example.com' },
		})
		expect(output).toContain('url: http://localhost/docs/intro')
		expect(output).toContain('slug: intro')
		expect(output).toContain('site: https://example.com')
	})

	it('should not interpolate directive attributes (x-, @, :, .)', async () => {
		// Directive attrs skip compileAttributeInterpolation; { foo } stays literal.
		const html = '<div x-bind:class="{ foo }"></div>'
		const parsed = parse(html)
		const code = compile(parsed, mockOptions)
		const output = await execute(code, {})
		expect(output).toContain('x-bind:class="{ foo }"')
	})

	it('should normalize absolute attr paths that include parent segments', async () => {
		const html = '<form hx-post="/api/submit"></form>'
		const parsed = parse(html)
		const code = compile(parsed, {
			root: process.cwd(),
			resolvePath: (_s: string, _i: string) => '/../../../../api/submit',
		})

		const output = await execute(code)
		expect(output).toContain('hx-post="/api/submit"')
		expect(output).not.toContain('/../../../../api/submit')
	})

	it('should support default content in slots', async () => {
		const html = `<script is:build>
										const nav = { name: 'nav' };
									</script>
									<slot name="nav">
										<nav-component />
									</slot>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const Aero = {
			slots: {}, // Empty slots at runtime
			renderComponent: async (_comp: any) => '<nav-mock />',
		}

		const output = await execute(code, Aero)
		expect(output).toContain('<nav-mock />')
	})

	it('emits component-in-slot-default with full context from single source (same as emit.ts)', () => {
		// Component in slot default content uses codegen's compileElementDefaultContent path
		const html = `<script is:build></script><slot name="nav"><nav-component /></slot>`
		const parsed = parse(html)
		const code = compile(parsed, mockOptions)
		const contextArg = getRenderComponentContextArg()
		expect(code).toContain(contextArg)
	})

	it('should support inline object literals in aero-props', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
									</script>
									<my-comp-component aero-props="{ title: 'Inline Title', count: 42 }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ title: 'Inline Title', count: 42 })
	})

	it('should support expressions in aero-props', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
										const site = { meta: { title: 'Test Site' } };
									</script>
									<my-comp-component aero-props="{ title: site.meta.title, doubled: 2 * 21 }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ title: 'Test Site', doubled: 42 })
	})

	it('should throw when aero-props value is not brace-wrapped', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
										const myProps = { a: 1, b: 2 };
									</script>
									<my-comp-component aero-props="myProps" />`

		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(
			'Directive `aero-props` on <my-comp-component> must use a braced expression'
		)
	})

	it('should throw when if value is not brace-wrapped', async () => {
		const html = `<script is:build>
										const showLogo = true;
									</script>
									<logo-component if="showLogo" />`

		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(
			'Directive `if` on <logo-component> must use a braced expression'
		)
	})

	it('should throw when for value is not brace-wrapped', async () => {
		const html = `<script is:build>
										const items = ['a', 'b'];
									</script>
									<ul>
										<li for="const item of items">{ item }</li>
									</ul>`

		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(
			'Directive `for` on <li> must use a braced expression'
		)
	})

	it('should merge aero-props with individual attributes', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
									</script>
									<my-comp-component 
										aero-props="{ base: 'value' }" 
										extra="{ 'additional' }" />`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const renderedProps: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any) => {
				renderedProps.push(props)
				return ''
			},
		}

		await execute(code, Aero)
		expect(renderedProps[0]).toEqual({ base: 'value', extra: 'additional' })
	})

	/** Grandparent → parent → child: parent receives slot and forwards via <slot name="nav" slot="nav">. */
	it('should support slot passthrough (receiving and forwarding named slots)', async () => {
		const html = `<script is:build>
										const parent = { name: 'parent' };
										const child = { name: 'child' };
									</script>
									<parent-component>
										<div slot="nav">Custom Navigation</div>
									</parent-component>`

		const parentTemplate = `<script is:build>
														const child = { name: 'child' };
													</script>
													<child-component>
														<slot name="nav" slot="nav"/>
													</child-component>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		// Parse parent template to see what it will pass to child
		const parsedParent = parse(parentTemplate)
		const parentCode = compile(parsedParent, mockOptions)

		const calls: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any, slots: any) => {
				calls.push({ comp, props, slots })

				// If this is the parent component, execute its template with the received slots
				if (comp.name === 'parent') {
					const bodyStart = parentCode.indexOf('{')
					const bodyEnd = parentCode.lastIndexOf('}')
					const body = parentCode.substring(bodyStart + 1, bodyEnd)
					const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
					const renderFn = new AsyncFunction('Aero', body)
					return await renderFn({ ...Aero, slots })
				}

				// For child, just return slots to verify
				if (comp.name === 'child') {
					return slots.nav || ''
				}

				return ''
			},
		}

		const output = await execute(code, Aero)

		// Verify that parent received the nav slot
		const parentCall = calls.find(c => c.comp.name === 'parent')
		expect(parentCall).toBeDefined()
		expect(parentCall.slots.nav).toContain('Custom Navigation')

		// Verify that child also received the nav slot (passed through from parent)
		const childCall = calls.find(c => c.comp.name === 'child')
		expect(childCall).toBeDefined()
		expect(childCall.slots.nav).toContain('Custom Navigation')

		// Final output should contain the navigation content
		expect(output).toContain('Custom Navigation')
	})

	it('should support hyphenated slot names', async () => {
		const html = `<script is:build>
										const myComp = { name: 'comp' };
									</script>
									<my-comp-component>
										<div slot="side-bar">Side Content</div>
									</my-comp-component>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const calls: any[] = []
		const Aero = {
			renderComponent: async (comp: any, props: any, slots: any) => {
				calls.push({ comp, slots })
				return ''
			},
		}

		await execute(code, Aero)

		expect(calls[0].slots['side-bar']).toContain('Side Content')
	})

	// =========================================================================
	// if/else-if/else conditional chains (if / else-if / else or if/else-if/else)
	// =========================================================================

	it('should compile simple if/else chain', async () => {
		const html = `<script is:build>
										const showFirst = false;
									</script>
									<div>
										<p if="{ showFirst }">First</p>
										<p else>Fallback</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Fallback')
		expect(output).not.toContain('First')
	})

	it('should compile if/else-if/else chain (else-if matches)', async () => {
		const html = `<script is:build>
										const value = 'B';
									</script>
									<div>
										<p if="{ value === 'A' }">Option A</p>
										<p else-if="{ value === 'B' }">Option B</p>
										<p else>Default</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Option B')
		expect(output).not.toContain('Option A')
		expect(output).not.toContain('Default')
	})

	it('should compile if/else-if/else chain (else matches)', async () => {
		const html = `<script is:build>
										const value = 'C';
									</script>
									<div>
										<p if="{ value === 'A' }">Option A</p>
										<p else-if="{ value === 'B' }">Option B</p>
										<p else>Default</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Default')
		expect(output).not.toContain('Option A')
		expect(output).not.toContain('Option B')
	})

	it('should compile multiple else-if branches', async () => {
		const html = `<script is:build>
										const num = 3;
									</script>
									<div>
										<span if="{ num === 1 }">One</span>
										<span else-if="{ num === 2 }">Two</span>
										<span else-if="{ num === 3 }">Three</span>
										<span else>Other</span>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Three')
		expect(output).not.toContain('One')
		expect(output).not.toContain('Two')
		expect(output).not.toContain('Other')
	})

	it('should compile if/else with components', async () => {
		const html = `<script is:build>
										const showLogo = false;
										const logo = { name: 'logo' };
									</script>
									<div>
										<logo-component if="{ showLogo }" />
										<p else>No logo</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const Aero = {
			renderComponent: async (comp: any) => `<img src="${comp.name}.svg" />`,
		}

		const output = await execute(code, Aero)
		expect(output).toContain('No logo')
		expect(output).not.toContain('<img')
	})

	it('should handle if without else (standalone)', async () => {
		const html = `<script is:build>
										const show = true;
									</script>
									<div>
										<p if="{ show }">Shown</p>
										<p>Always visible</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Shown')
		expect(output).toContain('Always visible')
	})

	it('should support data- prefix for conditionals', async () => {
		const html = `<script is:build>
										const choice = 2;
									</script>
									<div>
										<p if="{ choice === 1 }">One</p>
										<p else-if="{ choice === 2 }">Two</p>
										<p else>Other</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Two')
		expect(output).not.toContain('One')
		expect(output).not.toContain('Other')
	})

	it('should compile wrapperless template if (children only, no template tag in output)', async () => {
		const html = `<script is:build>
										const condition = true;
									</script>
									<div>
										<template if="{ condition }">
											<h1>Title</h1>
											<main>Body</main>
										</template>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<h1>Title</h1>')
		expect(output).toContain('<main>Body</main>')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should omit wrapperless template branch when condition is false', async () => {
		const html = `<script is:build>
										const condition = false;
									</script>
									<div>
										<template if="{ condition }">
											<h1>Nope</h1>
										</template>
										<p>Always</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).not.toContain('Nope')
		expect(output).toContain('Always')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should compile wrapperless template if / else-if / else chain', async () => {
		const html = `<script is:build>
										const state = 'error';
									</script>
									<div>
										<template if="{ state === 'loading' }">
											<p>Loading</p>
										</template>
										<template else-if="{ state === 'error' }">
											<p>Error</p>
										</template>
										<template else>
											<p>Ready</p>
										</template>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<p>Error</p>')
		expect(output).not.toContain('Loading')
		expect(output).not.toContain('Ready')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should allow mixed wrapperless template and element branches', async () => {
		const html = `<script is:build>
										const ready = true;
									</script>
									<div>
										<template if="{ !ready }">
											<p>Loading</p>
										</template>
										<section else class="panel">
											<h1>Ready</h1>
										</section>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<section class="panel">')
		expect(output).toContain('<h1>Ready</h1>')
		expect(output).not.toContain('Loading')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should compile wrapperless template if inside component default slot', async () => {
		const html = `<script is:build>
										const layout = { name: 'layout' };
									</script>
									<layout-component>
										<template if="{ true }">
											<p>Hello</p>
										</template>
									</layout-component>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const Aero = {
			renderComponent: async (_comp: any, _props: any, slots: any) => slots.default ?? '',
		}

		const output = await execute(code, Aero)
		expect(output).toContain('<p>Hello</p>')
		expect(output).not.toMatch(/<template[\s>]/i)
	})

	it('should treat lone aero-else (invalid markup) as normal element and strip directive', async () => {
		// aero-else without preceding if is not a conditional chain; element is compiled as normal, directive stripped
		const html = `<script is:build></script>
									<div>
										<p aero-else>Standalone else</p>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('Standalone else')
		expect(output).not.toContain('aero-else')
	})

	// =========================================================================
	// Void elements and self-closing component handling
	// =========================================================================

	it('should emit void elements without closing tags', async () => {
		const html = `<script is:build>
										const src = 'photo.jpg';
									</script>
									<div>
										<br>
										<img src="{ src }">
										<hr>
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<br>')
		expect(output).not.toContain('</br>')
		expect(output).toContain('<img src="photo.jpg">')
		expect(output).not.toContain('</img>')
		expect(output).toContain('<hr>')
		expect(output).not.toContain('</hr>')
	})

	it('should expand self-closing component and emit same component call as with closing tag', () => {
		// Self-closing <logo-component /> is expanded to <logo-component></logo-component> before parse;
		// then compiled like any component. We assert on generated code (imports are module-level, so execute() has no logo).
		const html = `<script is:build>
										import logo from '@components/logo.html'
									</script>
									<div>
										<logo-component />
									</div>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		expect(code).toContain('Aero.renderComponent(logo,')
	})

	// =========================================================================
	// getStaticPaths extraction
	// =========================================================================

	it('should extract getStaticPaths as a named export', async () => {
		const html = `<script is:build>
										const title = 'Hello';
										export function getStaticPaths() {
											return [
												{ params: { id: 'alpha' } },
												{ params: { id: 'beta' } },
											]
										}
									</script>
									<h1>{ title }</h1>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		// Should contain the named export
		expect(code).toContain('export function getStaticPaths()')
		// Should still contain the render function
		expect(code).toContain('export default async function')
		// The render function should still work
		const output = await execute(code)
		expect(output).toContain('<h1>Hello</h1>')
	})

	it('should extract async getStaticPaths as a named export', async () => {
		const html = `<script is:build>
										export async function getStaticPaths() {
											return [{ params: { slug: 'intro' } }]
										}
									</script>
									<p>Content</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		expect(code).toContain('export async function getStaticPaths()')
		expect(code).toContain('export default async function')
	})

	it('should not break when there is no getStaticPaths', async () => {
		const html = `<script is:build>
										const x = 1;
									</script>
									<p>{ x }</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		expect(code).not.toContain('getStaticPaths')
		expect(code).toContain('export default async function')
		const output = await execute(code)
		expect(output).toContain('<p>1</p>')
	})
	// =========================================================================
	// props (script/style) - template-level features
	// =========================================================================

	describe('props (script/style)', () => {
		it('should pass data to inline scripts with variable injection', async () => {
			const html = `<script is:build>
											const config = { theme: 'dark' };
										</script>
										<script is:inline props="{ config }">
											console.log(config.theme);
										</script>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const output = await execute(code)

			// Should create a literal mapping expression inline
			expect(output).toContain('const config = {"theme":"dark"};')
			expect(output).toContain('console.log(config.theme);')
			// Because it is inline, there's no module or json bridge.
		})

		/** props="{ theme }" passes one key "theme" (whole object); use props="{ ...theme }" for properties as CSS vars. */
		it('should pass data to style tags as CSS variables', async () => {
			const html = `<script is:build>
											const theme = { fg: 'white', bg: 'black' };
										</script>
										<style props="{ theme }">
											body { color: var(--theme); }
										</style>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const styles = new Set<string>()
			await execute(code, { styles })
			const stylesOutput = Array.from(styles).join('\n')

			expect(stylesOutput).toContain(':root {')
			expect(stylesOutput).toContain('--theme: [object Object];')
			expect(stylesOutput).toContain('}')
		})

		it('should pass data object properties to style tags as CSS variables', async () => {
			const html = `<script is:build>
											const theme = { fg: 'white', bg: 'black' };
										</script>
										<style props="{ ...theme }">
											body { color: var(--fg); background: var(--bg); }
										</style>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const styles = new Set<string>()
			await execute(code, { styles })
			const stylesOutput = Array.from(styles).join('\n')

			expect(stylesOutput).toContain(':root {')
			expect(stylesOutput).toContain('--fg: white;')
			expect(stylesOutput).toContain('--bg: black;')
			expect(stylesOutput).toContain('}')
		})

		it('should pass multiple data keys to inline scripts', async () => {
			const html = `<script is:build>
											const apiUrl = '/api/v1';
											const debug = true;
											const version = 3;
										</script>
										<script is:inline props="{ apiUrl, debug, version }">
											console.log(apiUrl, debug, version);
										</script>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const output = await execute(code)

			expect(output).toContain('const apiUrl = "\\u002Fapi\\u002Fv1";')
			expect(output).toContain('const debug = true;')
			expect(output).toContain('const version = 3;')
		})

		it('should handle various JSON-serializable value types', async () => {
			const html = `<script is:build>
											const str = 'hello';
											const num = 99;
											const flag = false;
											const list = [1, 2, 3];
											const nothing = null;
										</script>
										<script is:inline props="{ str, num, flag, list, nothing }">
											console.log(str, num, flag, list, nothing);
										</script>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const output = await execute(code)

			expect(output).toContain('const str = "hello";')
			expect(output).toContain('const num = 99;')
			expect(output).toContain('const flag = false;')
			expect(output).toContain('const list = [1,2,3];')
			expect(output).toContain('const nothing = null;')
		})

		it('should pass data via props on script and style (canonical API)', async () => {
			const html = `<script is:build>
				const theme = { fg: '#333', bg: '#fff' };
			</script>
			<style props="{ ...theme }">
				body { color: var(--fg); background: var(--bg); }
			</style>
			<script props="{ theme }">
				console.log(theme);
			</script>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const styles = new Set<string>()
			await execute(code, { styles })
			const stylesOutput = Array.from(styles).join('\n')

			expect(stylesOutput).toContain('--fg: #333;')
			expect(stylesOutput).toContain('--bg: #fff;')
		})

		it('should support aero-props on script and style (matches component syntax)', async () => {
			const html = `<script is:build>
				const theme = { fg: '#111', bg: '#eee' };
			</script>
			<style aero-props="{ ...theme }">
				body { color: var(--fg); background: var(--bg); }
			</style>`

			const parsed = parse(html)
			const code = compile(parsed, mockOptions)

			const styles = new Set<string>()
			await execute(code, { styles })
			const stylesOutput = Array.from(styles).join('\n')

			expect(stylesOutput).toContain('--fg: #111;')
			expect(stylesOutput).toContain('--bg: #eee;')
		})

		it('should import Vite-processed CSS modules when styleCssModuleIds is set', async () => {
			const html = `<style>
				.card { color: red; }
			</style>
			<p>hi</p>`
			const moduleId = 'virtual:aero-style-test?inline&index=0.css'
			const parsed = parse(html)
			const code = compile(parsed, {
				...mockOptions,
				styleCssModuleIds: [moduleId],
			})

			expect(code).toContain(`import __aero_css_0 from ${JSON.stringify(moduleId)}`)
			expect(code).toContain('__aero_css_0')
			expect(code).not.toContain('.card { color: red; }')

			const defaultIdx = code.indexOf('export default async function')
			const renderCode = code.slice(defaultIdx)
			const bodyStart = renderCode.indexOf('{')
			const bodyEnd = renderCode.lastIndexOf('}')
			const body =
				"const __aero_css_0 = '.card{color:red}';\n" + renderCode.substring(bodyStart + 1, bodyEnd)
			const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
			const renderFn = new AsyncFunction('Aero', body)
			const styles = new Set<string>()
			await renderFn({
				styles,
				scripts: new Set(),
				headScripts: new Set(),
				renderComponent: async () => '',
				page: {
					url: new URL('http://localhost'),
					request: new Request('http://localhost'),
					params: {},
				},
				site: { url: '' },
				slots: {},
				props: {},
				escapeHtml,
				escapeScriptJson,
				raw,
				trim,
				trimStart,
				trimEnd,
			})
			const stylesOutput = Array.from(styles).join('\n')
			expect(stylesOutput).toContain('<style>')
			expect(stylesOutput).toContain('.card{color:red}')
			expect(stylesOutput).toContain('</style>')
		})

		it('should keep style props CSS vars with styleCssModuleIds', async () => {
			const html = `<script is:build>
				const theme = { fg: 'white', bg: 'black' };
			</script>
			<style props="{ ...theme }">
				body { color: var(--fg); }
			</style>`
			const moduleId = 'virtual:aero-style-theme?inline&index=0.css'
			const parsed = parse(html)
			const code = compile(parsed, {
				...mockOptions,
				styleCssModuleIds: [moduleId],
			})
			const defaultIdx = code.indexOf('export default async function')
			const renderCode = code.slice(defaultIdx)
			const bodyStart = renderCode.indexOf('{')
			const bodyEnd = renderCode.lastIndexOf('}')
			const body =
				"const __aero_css_0 = 'body { color: var(--fg); }';\n" +
				renderCode.substring(bodyStart + 1, bodyEnd)
			const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
			const renderFn = new AsyncFunction('Aero', body)
			const styles = new Set<string>()
			await renderFn({
				styles,
				scripts: new Set(),
				headScripts: new Set(),
				renderComponent: async () => '',
				page: {
					url: new URL('http://localhost'),
					request: new Request('http://localhost'),
					params: {},
				},
				site: { url: '' },
				slots: {},
				props: {},
				escapeHtml,
				escapeScriptJson,
				raw,
				trim,
				trimStart,
				trimEnd,
			})
			const stylesOutput = Array.from(styles).join('\n')
			expect(stylesOutput).toContain('--fg: white;')
			expect(stylesOutput).toContain('--bg: black;')
			expect(stylesOutput).toContain('body { color: var(--fg); }')
		})

		it('should throw when props value is not a single braced expression (tokenizer validation)', () => {
			const html = `<script is:build></script><div props="literal">x</div>`
			const parsed = parse(html)
			expect(() => compile(parsed, mockOptions)).toThrow(
				'Directive `props` on <div> must use a braced expression'
			)
		})

		it('accepts adjacent {{ as a single nested-JS braced props expression', () => {
			const html = `<script is:build>
				const literal = { a: 1 }
			</script><div props="{{ ...literal }}">x</div>`
			const parsed = parse(html)
			expect(() => compile(parsed, mockOptions)).not.toThrow()
		})

		it('collects warning for non-directive attributes on wrapperless template', () => {
			const html = `<template if="{ ready }" class="panel" data-test="x"><p>ok</p></template>`
			const parsed = parse(html)
			const warnings: Array<{ code: string; message: string }> = []
			compile(parsed, {
				...mockOptions,
				onWarning: w => warnings.push({ code: w.code, message: w.message }),
			})
			expect(warnings).toHaveLength(1)
			expect(warnings[0]?.code).toBe('AERO_TEMPLATE')
			expect(warnings[0]?.message).toContain('Wrapperless <template> ignores non-directive')
			expect(warnings[0]?.message).toContain('class')
		})

		it('collects warning for duplicate switch cases and missing default', () => {
			const html = `<div switch="{ status }"><span case="ready">a</span><span case="ready">b</span></div>`
			const parsed = parse(html)
			const warnings: Array<{ code: string; message: string }> = []
			compile(parsed, {
				...mockOptions,
				onWarning: w => warnings.push({ code: w.code, message: w.message }),
			})
			expect(warnings.some(w => w.code === 'AERO_SWITCH' && w.message.includes('Duplicate'))).toBe(
				true
			)
			expect(
				warnings.some(w => w.code === 'AERO_SWITCH' && w.message.includes('no `default` branch'))
			).toBe(true)
		})

		it('collects warning when for loop binding shadows loop metadata', () => {
			const html = `<ul><li for="{ const index of items }">{ index }</li></ul>`
			const parsed = parse(html)
			const warnings: Array<{ code: string; message: string }> = []
			compile(parsed, {
				...mockOptions,
				diagnosticTemplateSource: html,
				onWarning: w => warnings.push({ code: w.code, message: w.message }),
			})
			expect(warnings).toHaveLength(1)
			expect(warnings[0]?.code).toBe('AERO_TEMPLATE')
			expect(warnings[0]?.message).toContain('shadows built-in loop metadata')
			expect(warnings[0]?.message).toContain('index')
		})
	})

	// =========================================================================
	// TypeScript support (type stripping)
	// =========================================================================

	it('should strip TypeScript type annotations from build scripts', async () => {
		const html = `<script is:build>
			const title: string = 'Hello';
			const count: number = 42;
		</script>
		<h1>{ title } - { count }</h1>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<h1>Hello - 42</h1>')
	})

	it('should strip TypeScript interfaces and type aliases from build scripts', async () => {
		const html = `<script is:build>
			interface PageProps {
				title: string;
				count: number;
			}
			type Status = 'active' | 'inactive';
			const props: PageProps = { title: 'Typed', count: 7 };
			const status: Status = 'active';
		</script>
		<p>{ props.title } ({ status })</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<p>Typed (active)</p>')
	})

	it('should strip TypeScript "as" type assertions from build scripts', async () => {
		const html = `<script is:build>
			const data = { name: 'Test' } as { name: string };
			const label = (data as any).name as string;
		</script>
		<span>{ label }</span>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<span>Test</span>')
	})

	it('should strip TypeScript generics from build scripts', async () => {
		const html = `<script is:build>
			function identity<T>(val: T): T { return val; }
			const result = identity<string>('generic');
		</script>
		<p>{ result }</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<p>generic</p>')
	})

	it('should strip TypeScript satisfies operator from build scripts', async () => {
		const html = `<script is:build>
			const config = { theme: 'dark', debug: false } satisfies Record<string, unknown>;
		</script>
		<p>{ config.theme }</p>`

		const parsed = parse(html)
		const code = compile(parsed, mockOptions)

		const output = await execute(code)
		expect(output).toContain('<p>dark</p>')
	})
})

// =========================================================================
// analyzeBuildScript (build script analysis used by codegen for imports + getStaticPaths)
// =========================================================================

describe('analyzeBuildScript (getStaticPaths contract)', () => {
	it('should extract a sync getStaticPaths and remaining script', () => {
		const script = `const x = 1;
export function getStaticPaths() {
	return [{ params: { id: 'a' } }]
}
const y = 2;`

		const result = analyzeBuildScript(script)

		expect(result.getStaticPathsFn).toContain('export function getStaticPaths()')
		expect(result.getStaticPathsFn).toContain("return [{ params: { id: 'a' } }]")
		expect(result.scriptWithoutImportsAndGetStaticPaths).toContain('const x = 1;')
		expect(result.scriptWithoutImportsAndGetStaticPaths).toContain('const y = 2;')
		expect(result.scriptWithoutImportsAndGetStaticPaths).not.toContain('getStaticPaths')
	})

	it('should extract async getStaticPaths with empty remaining', () => {
		const script = `export async function getStaticPaths() {
	const data = await fetch('/api')
	return data
}`

		const result = analyzeBuildScript(script)

		expect(result.getStaticPathsFn).toContain('export async function getStaticPaths()')
		expect(result.getStaticPathsFn).toContain('await fetch')
		expect(result.scriptWithoutImportsAndGetStaticPaths).toBe('')
	})

	it('should handle nested braces in getStaticPaths', () => {
		const script = `export function getStaticPaths() {
	const items = [{ a: 1 }, { b: 2 }]
	if (items.length > 0) {
		return items.map(i => ({ params: i }))
	}
	return []
}`

		const result = analyzeBuildScript(script)

		expect(result.getStaticPathsFn).not.toBeNull()
		expect(result.getStaticPathsFn).toContain('return []')
		expect(result.scriptWithoutImportsAndGetStaticPaths).toBe('')
	})

	it('should return null getStaticPathsFn when no getStaticPaths exists', () => {
		const script = `const x = 1;
const y = 2;`

		const result = analyzeBuildScript(script)

		expect(result.getStaticPathsFn).toBeNull()
		expect(result.scriptWithoutImportsAndGetStaticPaths).toBe(script.trim())
	})
})

describe('event directive validation', () => {
	it('errors when event directive has malformed modifier chain', () => {
		const html = `<button on:click..prevent="{ submit() }">Save</button>`
		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(/malformed modifier chain/i)
	})

	it('errors when event directive value is not braced expression', () => {
		const html = `<button on:click="submit()">Save</button>`
		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(/must use a braced expression/i)
	})
})

describe('state script diagnostics scaffold', () => {
	it('errors when derived state is assigned in is:state script', () => {
		const html = `
			<script is:state>
				let a = 1
				let b = a + 2
				b = 10
			</script>
			<div>ok</div>
		`
		const parsed = parse(html)
		expect(() => compile(parsed, mockOptions)).toThrow(/Derived state `b` is read-only/)
	})
})
