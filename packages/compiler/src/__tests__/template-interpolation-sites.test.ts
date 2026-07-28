import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import {
	collectTemplateInterpolationSites,
	buildTemplateInterpolationVirtualText,
	formatInterpolationBinderPreludeFromTemplate,
} from '../template-interpolation-sites'

describe('collectTemplateInterpolationSites', () => {
	it('ignores component props expressions inside HTML comments', () => {
		const html = `<!--<card-component props="{ ...props }" />-->\n<p>{ title }</p>`
		const sites = collectTemplateInterpolationSites(html)
		expect(sites).toHaveLength(1)
		expect(sites[0]?.expression.trim()).toBe('title')
	})

	it('marks props attribute interpolations for object-literal virtual wrap', () => {
		const html = `<x-component props="{ ...p }" /><p>{ other }</p>`
		const sites = collectTemplateInterpolationSites(html)
		expect(sites).toHaveLength(2)
		expect(sites[0]?.expression.trim()).toBe('...p')
		expect(sites[0]?.wrapPropsObjectLiteral).toBe(true)
		expect(sites[1]?.wrapPropsObjectLiteral).toBeFalsy()
	})

	it('treats aero-props like props', () => {
		const html = `<x aero-props="{ ...p }" />`
		const sites = collectTemplateInterpolationSites(html)
		expect(sites[0]?.wrapPropsObjectLiteral).toBe(true)
	})

	it('includes for-loop bindings in same-tag attribute interpolation prelude', () => {
		const html = `<a for="{ const { path, label } of links }" href="{ path }"> { label } </a>`
		const sites = collectTemplateInterpolationSites(html)
		const hrefSite = sites.find(s => s.expression.trim() === 'path')
		expect(hrefSite).toBeDefined()
		const prelude = formatInterpolationBinderPreludeFromTemplate(html, hrefSite!.braceOffset)
		expect(prelude).toContain('declare const path: any;')
	})

	it('includes braced expressions on Aero event directives', () => {
		const html = `<button on:click="{ inc() }">+</button><p>{ count }</p>`
		const sites = collectTemplateInterpolationSites(html)
		expect(sites.some(s => s.expression.trim() === 'inc()')).toBe(true)
		expect(sites.some(s => s.expression.trim() === 'count')).toBe(true)
		const eventSite = sites.find(s => s.expression.trim() === 'inc()')
		expect(eventSite?.isEventHandler).toBe(true)
	})

	it('does not treat component markup inside template literal snippets as attribute sites', () => {
		const html = `<code>{ \`<header-component bind:count="{ \${count} }" />\` }</code>`
		const sites = collectTemplateInterpolationSites(html)
		expect(sites).toHaveLength(1)
		expect(sites[0]?.expression.trim()).toBe(
			'`<header-component bind:count="{ ${count} }" />`'
		)
		const { virtualText } = buildTemplateInterpolationVirtualText(html, sites[0]!, '')
		expect(virtualText).toContain('${count}')
		expect(virtualText).not.toContain('[bind:count')
	})

	it('typechecks is:state assignments in event handlers with declare let and statement context', () => {
		const html = `<script is:state>let count = 0</script><button on:dblclick="{ count = 0 }">Reset</button>`
		const sites = collectTemplateInterpolationSites(html)
		const eventSite = sites.find(s => s.isEventHandler)
		expect(eventSite).toBeDefined()

		const { virtualText } = buildTemplateInterpolationVirtualText(html, eventSite!, '')
		expect(virtualText).toContain('declare let count')
		expect(virtualText).not.toContain('[ count = 0 ]')
		expect(virtualText).toContain('count = 0')
		expect(virtualText.endsWith(';')).toBe(true)
	})

	it('declares readonly reactive props as let in event handler virtual TS so Aero can own the diagnostic', () => {
		const html = `<script is:state>const { count } = Aero.props</script><button on:click="{ count++ }">+</button>`
		const sites = collectTemplateInterpolationSites(html)
		const eventSite = sites.find(s => s.isEventHandler)
		expect(eventSite).toBeDefined()

		const { virtualText } = buildTemplateInterpolationVirtualText(html, eventSite!, '')
		expect(virtualText).toContain('declare let count')
		expect(virtualText).toContain('count++')
	})

	it('keeps read-only interpolation bindings as declare const', () => {
		const html = `<script is:state>let count = 0</script><p>{ count }</p>`
		const prelude = formatInterpolationBinderPreludeFromTemplate(html, html.indexOf('count'))
		expect(prelude).toContain('declare const count')
		expect(prelude).not.toContain('declare let count')
	})

	it('declares event in on:* handler virtual TS', () => {
		const html = `<script is:state>
function syncAuthLink(event) { event.preventDefault() }
</script>
<a on:click="{ syncAuthLink(event) }">x</a>`
		const sites = collectTemplateInterpolationSites(html)
		const eventSite = sites.find(s => s.isEventHandler)
		expect(eventSite).toBeDefined()
		const { virtualText } = buildTemplateInterpolationVirtualText(html, eventSite!, '')
		expect(virtualText).toContain('declare const event: Event;')
		expect(virtualText).toMatch(/declare const event: Event;\s*syncAuthLink\(event\)/)
	})

	it('typechecks adjacent {{ as nested JS in text content', () => {
		const html = `<script is:build>
const count = 1
const trustedHTML = '<em>Trusted HTML</em>'
</script>
<dt>{{ raw(trustedHTML) }}</dt>
<p><code>if="{{ count > 0 }}"</code> at build</p>
<p>{ count }</p>`
		const sites = collectTemplateInterpolationSites(html)
		const expressions = sites.map(s => s.expression.trim())
		expect(expressions).toContain('{ raw(trustedHTML) }')
		expect(expressions).toContain('{ count > 0 }')
		expect(expressions).toContain('count')
	})

	it('includes braced expressions on Aero reactive binding directives', () => {
		const html = `<script is:state>
	let body = 'x'
	let saving = false
</script>
<div show="{ open }" class:is-active="{ active }" html="{ body }" busy="{ saving }"></div>`
		const sites = collectTemplateInterpolationSites(html)
		const expressions = sites.map(s => s.expression.trim())
		expect(expressions).toContain('open')
		expect(expressions).toContain('active')
		expect(expressions).toContain('body')
		expect(expressions).toContain('saving')
	})

	it('emits TS2304 for missing names in show and class:* binding virtual TS', () => {
		const html = `<script is:state>
	let body = 'x'
	let saving = false
</script>
<div show="{ isOpen }" class:is-active="{ isActive }"></div>`
		const sites = collectTemplateInterpolationSites(html)
		const openSite = sites.find(s => s.expression.trim() === 'isOpen')
		const activeSite = sites.find(s => s.expression.trim() === 'isActive')
		expect(openSite).toBeDefined()
		expect(activeSite).toBeDefined()

		for (const site of [openSite!, activeSite!]) {
			const { virtualText } = buildTemplateInterpolationVirtualText(html, site, '')
			const source = ts.createSourceFile('expr.ts', virtualText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
			const opts: ts.CompilerOptions = {
				target: ts.ScriptTarget.ESNext,
				module: ts.ModuleKind.ESNext,
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			}
			const host = ts.createCompilerHost(opts)
			const originalGetSourceFile = host.getSourceFile.bind(host)
			host.getSourceFile = (fileName, languageVersion, ...rest) => {
				if (fileName.endsWith('expr.ts')) return source
				return originalGetSourceFile(fileName, languageVersion, ...rest)
			}
			const program = ts.createProgram(['expr.ts'], opts, host)
			const codes = program.getSemanticDiagnostics(source).map(d => d.code)
			expect(codes.some(code => code === 2304 || code === 2552)).toBe(true)
		}
	})

	it('does not extract interpolations from Alpine directive attribute values', () => {
		const html = `<div x-bind:class="{ foo }">{ bar }</div>`
		const sites = collectTemplateInterpolationSites(html)
		expect(sites).toHaveLength(1)
		expect(sites[0]?.expression.trim()).toBe('bar')
	})

	it('typechecks hypermedia state option with owned boolean binding', () => {
		const html = `<script is:state>let isSaving = false</script>
<button busy="{ isSaving }" on:click="{ POST('/api/save', { target: '#save-status', state: isSaving }) }">Save</button>`
		const sites = collectTemplateInterpolationSites(html)
		const eventSite = sites.find(s => s.isEventHandler)
		expect(eventSite).toBeDefined()

		const { virtualText } = buildTemplateInterpolationVirtualText(html, eventSite!, '')
		expect(virtualText).toContain('state: __aeroSignal("isSaving")')
		expect(virtualText).toContain('declare function __aeroSignal')

		const source = ts.createSourceFile('expr.ts', virtualText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('expr.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['expr.ts'], opts, host)
		const codes = program.getSemanticDiagnostics(source).map(d => d.code)
		expect(codes).not.toContain(2322)
	})

	it('collects for-directive heads as type-check sites', () => {
		const html = `<div for="{ const item of items }"></div>`
		const sites = collectTemplateInterpolationSites(html)
		const forHead = sites.find(s => s.isForDirectiveHead)
		expect(forHead?.expression.trim()).toBe('const item of items')
		expect(forHead?.expressionOffset).toBeGreaterThan(forHead!.braceOffset)
		const { virtualText } = buildTemplateInterpolationVirtualText(html, forHead!, '')
		expect(virtualText).toContain('for (const item of items) {}')
	})

	it('flags non-iterable for-directive iterable in virtual TS', () => {
		const html = `<script is:build>
const site = { demos: [{ label: 'A', href: '/a' }] }
</script>
<li for="{ const demo of site }">{ demo.label }</li>`
		const sites = collectTemplateInterpolationSites(html)
		const forHead = sites.find(s => s.isForDirectiveHead)
		expect(forHead).toBeDefined()
		const { virtualText } = buildTemplateInterpolationVirtualText(
			html,
			forHead!,
			'declare const Aero: { props: Record<string, unknown> }\n'
		)
		expect(virtualText).toContain('declare const site:')
		const source = ts.createSourceFile('expr.ts', virtualText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('expr.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['expr.ts'], opts, host)
		const diags = program.getSemanticDiagnostics(source)
		expect(
			diags.some(d =>
				/iterable|Symbol\.iterator|must have a '\[Symbol\.iterator\]'/i.test(
					ts.flattenDiagnosticMessageText(d.messageText, '\n')
				)
			)
		).toBe(true)
	})
})
