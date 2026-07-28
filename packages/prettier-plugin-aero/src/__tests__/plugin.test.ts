import { describe, expect, it } from 'vitest'
import prettier from 'prettier'
import plugin from '../index.js'

const baseOptions = {
	parser: 'aero',
	plugins: [plugin],
	useTabs: true,
	tabWidth: 2,
	semi: false,
}

describe('prettier-plugin-aero integration', () => {
	it('formats html with standard prettier options and aero transforms', async () => {
		const input = `<section>
  <nav-component></nav-component>
  <p if="{ok}">{title}</p>
</section>`
		const output = await prettier.format(input, {
			...baseOptions,
			aeroAttributePrefix: 'none',
			aeroBracketSpacing: true,
			aeroSelfClosingComponents: true,
		})
		expect(output).toContain('<nav-component />')
		expect(output).toContain('if="{ ok }"')
		expect(output).toContain('{ title }')
	})

	it('leaves native HTML attributes (track default) untouched when prefixing directives', async () => {
		const input = `<video><track default /></video>`
		const output = await prettier.format(input, {
			...baseOptions,
			aeroAttributePrefix: 'aero',
			aeroBracketSpacing: true,
			aeroSelfClosingComponents: false,
		})
		expect(output).toContain('<track default')
		expect(output).not.toContain('aero-default')
	})

	it('formats script is:build blocks with embedded typescript formatting', async () => {
		const input = `<script is:build lang="ts">
import { getCollection, render } from 'aero:content'
const  foo={bar:1}
</script>`
		const output = await prettier.format(input, {
			...baseOptions,
			semi: false,
			singleQuote: true,
		})
		expect(output).toMatch(/const foo = \{ bar: 1 \}/)
		expect(output).not.toContain(';(getCollection')
	})

	it('formats script is:build without lang as typescript by default', async () => {
		const input = `<script is:build>
import { getCollection, render } from 'aero:content'
const  foo={bar:1}
type X = { a: string }
</script>`
		const output = await prettier.format(input, {
			...baseOptions,
			semi: false,
			singleQuote: true,
		})
		expect(output).toMatch(/const foo = \{ bar: 1 \}/)
		expect(output).not.toContain(';(getCollection')
		expect(output).not.toContain('lang="ts"')
	})

	it('formats nested object interpolations on one line end-to-end', async () => {
		const input = `<section data-example="{{ foo: 1 }}"></section>`
		const spaced = await prettier.format(input, {
			...baseOptions,
			aeroBracketSpacing: true,
		})
		expect(spaced).toContain('data-example="{ { foo: 1 } }"')
		expect(spaced).not.toMatch(/data-example="\{ \{\n/)

		const compact = await prettier.format(input, {
			...baseOptions,
			aeroBracketSpacing: false,
		})
		expect(compact).toContain('data-example="{{foo: 1}}"')
	})
})
