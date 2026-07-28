import { describe, expect, it } from 'vitest'
import { parseMinimalHtmlFromText } from '@aero-js/html-parser'
import { applyAeroTransforms } from '../transforms.js'
import { defaultAeroOptions } from '../options.js'

async function formatAero(
	source: string,
	options: Partial<typeof defaultAeroOptions> = {}
): Promise<string> {
	const doc = parseMinimalHtmlFromText(source)
	return applyAeroTransforms(source, doc.roots, { ...defaultAeroOptions, ...options }, {
		semi: false,
	})
}

describe('applyAeroTransforms', () => {
	it('rewrites build directives between bare and prefixed forms', async () => {
		const input = '<div aero-props="{ title }" aero-for="{ const x of xs }"></div>'
		const output = await formatAero(input, { aeroAttributePrefix: 'none' })
		expect(output).toContain('props="{ title }"')
		expect(output).toContain('for="{ const x of xs }"')
		expect(output).not.toContain('aero-props')
	})

	it('adds aero- prefix when aeroAttributePrefix is aero', async () => {
		const input = '<div props="{ title }" if="{ ok }"></div>'
		const output = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(output).toContain('aero-props="{ title }"')
		expect(output).toContain('aero-if="{ ok }"')
	})

	it('adds data-aero- prefix when aeroAttributePrefix is strict', async () => {
		const input = '<div props="{ title }" if="{ ok }"></div>'
		const output = await formatAero(input, { aeroAttributePrefix: 'strict' })
		expect(output).toContain('data-aero-props="{ title }"')
		expect(output).toContain('data-aero-if="{ ok }"')
	})

	it('migrates legacy data- prefix to configured form', async () => {
		const input = '<div data-props="{ title }" data-for="{ const x of xs }"></div>'
		const output = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(output).toContain('aero-props="{ title }"')
		expect(output).toContain('aero-for="{ const x of xs }"')
		expect(output).not.toContain('data-props')
		expect(output).not.toContain('data-for')
	})

	it('rewrites switch branch directives with string case and boolean default', async () => {
		const input =
			'<div switch="{ auth.state }"><a case="{ AuthState.SignedIn }">Out</a><a case="SignedOut">In</a><span default>Def</span></div>'
		const prefixed = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(prefixed).toContain('aero-switch="{ auth.state }"')
		expect(prefixed).toContain('aero-case="{ AuthState.SignedIn }"')
		expect(prefixed).toContain('aero-case="SignedOut"')
		expect(prefixed).toContain('aero-default')
		expect(prefixed).not.toMatch(/\scase=/)
		expect(prefixed).not.toMatch(/\sdefault>/)

		const bare = await formatAero(prefixed, { aeroAttributePrefix: 'none' })
		expect(bare).toContain('switch="{ auth.state }"')
		expect(bare).toContain('case="{ AuthState.SignedIn }"')
		expect(bare).toContain('case="SignedOut"')
		expect(bare).toContain('<span default>')
		expect(bare).not.toContain('aero-case')
		expect(bare).not.toContain('aero-default')
	})

	it('rewrites bare props attribute with prefix toggle', async () => {
		const input = '<header-component props />'
		const prefixed = await formatAero(input, { aeroAttributePrefix: 'strict' })
		expect(prefixed).toBe('<header-component data-aero-props />')

		const bare = await formatAero(prefixed, { aeroAttributePrefix: 'none' })
		expect(bare).toBe('<header-component props />')
	})

	it('rewrites earlier boolean props even when a later props= exists', async () => {
		const input = `<meta-component props />
<script props="{ storageKey, attribute }"></script>`
		const once = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(once).toContain('<meta-component aero-props />')
		expect(once).toContain('<script aero-props="{ storageKey, attribute }">')
		const twice = await formatAero(once, { aeroAttributePrefix: 'aero' })
		expect(twice).toBe(once)
	})

	it('does not parenthesize comma-separated props binding lists', async () => {
		const component = await formatAero(
			'<meta-component props="{ storageKey, attribute }" />',
			{ aeroBracketSpacing: true }
		)
		expect(component).toContain('props="{ storageKey, attribute }"')
		expect(component).not.toContain('(storageKey')

		const nestedScript = await formatAero(
			'<head><script props="{ storageKey, attribute }"></script></head>',
			{ aeroBracketSpacing: true }
		)
		expect(nestedScript).toContain('props="{ storageKey, attribute }"')
		expect(nestedScript).not.toContain('(storageKey')

		const healsExisting = await formatAero(
			'<head><script props="{ (storageKey, attribute) }"></script></head>',
			{ aeroBracketSpacing: true }
		)
		expect(healsExisting).toContain('props="{ storageKey, attribute }"')
		expect(healsExisting).not.toContain('(storageKey')
	})

	it('rewrites runtime, event, class, bind, key, and script is attrs', async () => {
		const input = `<script is:state>let count = 0
let open = true
let active = false</script>
<button on:click="{ count++ }" show="{ open }" class:is-active="{ active }" key="{ count }" text="{ count }"></button>
<header-component bind:count="{ count }" />`
		const aero = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(aero).toContain('<script aero-is:state>')
		expect(aero).toContain('aero-on:click="{ count++ }"')
		expect(aero).toContain('aero-show="{ open }"')
		expect(aero).toContain('aero-class:is-active="{ active }"')
		expect(aero).toContain('aero-key="{ count }"')
		expect(aero).toContain('aero-text="{ count }"')
		expect(aero).toContain('aero-bind:count="{ count }"')

		const data = await formatAero(input, { aeroAttributePrefix: 'strict' })
		expect(data).toContain('<script data-aero-is-state>')
		expect(data).toContain('data-aero-on-click="{ count++ }"')
		expect(data).toContain('data-aero-show="{ open }"')
		expect(data).toContain('data-aero-class-is-active="{ active }"')
		expect(data).toContain('data-aero-key="{ count }"')
		expect(data).toContain('data-aero-bind-count="{ count }"')

		const bare = await formatAero(data, { aeroAttributePrefix: 'none' })
		expect(bare).toContain('<script is:state>')
		expect(bare).toContain('on:click="{ count++ }"')
		expect(bare).toContain('class:is-active="{ active }"')
		expect(bare).toContain('bind:count="{ count }"')
	})

	it('does not rewrite native HTML or emit-only markers', async () => {
		const input = `<label for="email">Email</label>
<div data-aero-event="0" data-aero-bind="1"></div>`
		const output = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(output).toContain('for="email"')
		expect(output).toContain('data-aero-event="0"')
		expect(output).toContain('data-aero-bind="1"')
		expect(output).not.toContain('aero-for')
	})

	it('does not rewrite plain html for attribute', async () => {
		const input = '<label for="email">Email</label>'
		const output = await formatAero(input, { aeroAttributePrefix: 'aero' })
		expect(output).toContain('for="email"')
		expect(output).not.toContain('aero-for')
	})

	it('applies aeroBracketSpacing to directive values and text interpolation', async () => {
		const input = '<p if="{ok}">{title}</p>'
		const spaced = await formatAero(input, { aeroBracketSpacing: true })
		expect(spaced).toContain('if="{ ok }"')
		expect(spaced).toContain('{ title }')

		const compact = await formatAero(spaced, { aeroBracketSpacing: false })
		expect(compact).toContain('if="{ok}"')
		expect(compact).toContain('{title}')
	})

	it('applies aeroBracketSpacing to text next to element siblings', async () => {
		const input =
			'<p class="max-w-prose">{ site.home.subtitle } <a href="/docs">Get started</a>.</p>'
		const compact = await formatAero(input, { aeroBracketSpacing: false })
		expect(compact).toContain('{site.home.subtitle}')
		expect(compact).not.toContain('{ site.home.subtitle }')

		const spaced = await formatAero(
			'<p>{site.home.subtitle} <a href="/docs">Go</a>.</p>',
			{ aeroBracketSpacing: true }
		)
		expect(spaced).toContain('{ site.home.subtitle }')
	})

	it('applies aeroBracketSpacing inside template literals that look like HTML', async () => {
		const input = '<code>{ `<slot />` }</code>'
		const compact = await formatAero(input, { aeroBracketSpacing: false })
		expect(compact).toBe('<code>{`<slot />`}</code>')

		const spaced = await formatAero('<code>{`<slot />`}</code>', { aeroBracketSpacing: true })
		expect(spaced).toBe('<code>{ `<slot />` }</code>')
	})

	it('prefers self-closing *-component tags when enabled', async () => {
		const input = '<nav-component></nav-component>'
		const output = await formatAero(input, { aeroSelfClosingComponents: true })
		expect(output).toBe('<nav-component />')
	})

	it('does not self-close *-component tags with children', async () => {
		const input = '<nav-component><a href="/">Home</a></nav-component>'
		const output = await formatAero(input, { aeroSelfClosingComponents: true })
		expect(output).toContain('<nav-component>')
		expect(output).toContain('</nav-component>')
		expect(output).not.toMatch(/<nav-component\s*\/>/)
	})

	it('does not self-close *-layout tags', async () => {
		const input = '<site-layout></site-layout>'
		const output = await formatAero(input, { aeroSelfClosingComponents: true })
		expect(output).toBe('<site-layout></site-layout>')
	})

	it('applies aeroBracketSpacing to component prop attributes', async () => {
		const input = '<blank-layout title="{title}"><h1>{title}</h1></blank-layout>'
		const output = await formatAero(input, { aeroBracketSpacing: true })
		expect(output).toContain('title="{ title }"')
		expect(output).toContain('<h1>{ title }</h1>')
	})

	it('applies aeroBracketSpacing to braces inside mixed attribute strings', async () => {
		const input = '<base-layout title="Docs: {site.meta.title}" />'
		const spaced = await formatAero(input, { aeroBracketSpacing: true })
		expect(spaced).toContain('title="Docs: { site.meta.title }"')

		const compact = await formatAero(spaced, { aeroBracketSpacing: false })
		expect(compact).toContain('title="Docs: {site.meta.title}"')
	})

	it('applies aeroBracketSpacing to each brace region in a mixed attribute', async () => {
		const input = '<my-comp-component title="{title}/{slug}" />'
		const output = await formatAero(input, { aeroBracketSpacing: true })
		expect(output).toContain('title="{ title }/{ slug }"')
	})

	it('formats adjacent {{ object }} interpolations with aeroBracketSpacing', async () => {
		const input = '<section data-example="{{ foo: 1 }}"></section>'
		const spaced = await formatAero(input, { aeroBracketSpacing: true })
		expect(spaced).toContain('data-example="{ { foo: 1 } }"')
		expect(spaced).not.toMatch(/data-example="\{ \{\n/)

		const compact = await formatAero(input, { aeroBracketSpacing: false })
		expect(compact).toContain('data-example="{{foo: 1}}"')
	})

	it('keeps spaced object literal interpolations on one line', async () => {
		const input = '<section data-example="{ { foo: 1 } }"></section>'
		const spaced = await formatAero(input, { aeroBracketSpacing: true })
		expect(spaced).toContain('data-example="{ { foo: 1 } }"')
		expect(spaced).not.toMatch(/data-example="\{ \{\n/)

		const compact = await formatAero(input, { aeroBracketSpacing: false })
		expect(compact).toContain('data-example="{{foo: 1}}"')
	})

	it('formats nested object and sibling interpolations in mixed attributes', async () => {
		const input = '<my-comp-component title="{{ slug }} + {slug}" />'
		const output = await formatAero(input, { aeroBracketSpacing: true })
		expect(output).toContain('title="{ { slug } } + { slug }"')
	})

	it('does not corrupt nested markup when compacting bracket spacing', async () => {
		const input = `<blank-layout title="{ title }">
	<main>
		<header>
			<h1>{ title }</h1>
			<p>Sorry, the page you are looking for does not exist.</p>
		</header>
	</main>
</blank-layout>`
		const output = await formatAero(input, { aeroBracketSpacing: false })
		expect(output).toContain('<h1>{title}</h1>')
		expect(output).toContain('<p>Sorry, the page you are looking for does not exist.</p>')
		expect(output).not.toContain('<h1>{title}\n\t\t\t<p')
	})

	it('does not corrupt import destructuring inside script is:build blocks', async () => {
		const input = `<script is:build lang="ts">
import { getCollection, render } from 'aero:content'
</script>`
		const output = await formatAero(input, { aeroBracketSpacing: true })
		expect(output).toContain('import { getCollection, render } from')
		expect(output).not.toContain(';(getCollection, render)')
	})

	it('expands self-closing *-component tags when option is false', async () => {
		const input = '<nav-component />'
		const output = await formatAero(input, { aeroSelfClosingComponents: false })
		expect(output).toBe('<nav-component></nav-component>')
	})

	it('does not prepend semicolons to template literal interpolations', async () => {
		const input = '<code>{ `bind:count="{ ${count} }"` }</code>'
		const output = await formatAero(input, { aeroBracketSpacing: true })
		expect(output).not.toContain('{ ;')
		expect(output).toContain('`bind:count="{ ${count} }"`')
	})

	it('does not prepend semicolons to string concat interpolations', async () => {
		const input = `<code>{ 'bind:count="{ ' + count + ' }"' }</code>`
		const output = await formatAero(input, { aeroBracketSpacing: true })
		expect(output).not.toContain('{ ;')
		expect(output).toContain('count')
	})
})
