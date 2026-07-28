import { describe, it, expect } from 'vitest'
import { parse } from '../../parser'
import { compile } from '../../codegen'
import { escapeHtml, raw } from '../../helpers'

async function execute(code: string) {
	const defaultIdx = code.indexOf('export default async function')
	const renderCode = defaultIdx >= 0 ? code.slice(defaultIdx) : code
	const bodyStart = renderCode.indexOf('{')
	const bodyEnd = renderCode.lastIndexOf('}')
	const body = renderCode.substring(bodyStart + 1, bodyEnd)
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
	const renderFn = new AsyncFunction('Aero', body)
	return renderFn({
		escapeHtml,
		raw,
		scripts: new Set(),
		headScripts: new Set(),
		styles: new Set(),
		renderComponent: async () => '',
		page: { url: new URL('http://x'), request: new Request('http://x'), params: {} },
		site: { url: '' },
		slots: {},
		props: {},
	})
}

describe('interpolation entity repro', () => {
	it('preserves entity-encoded braces as literal syntax in text', async () => {
		const html = `<script is:build>
      const escapedHtml = '<em>Escaped HTML</em>';
      const literalBraces = '{ not interpolated }';
    </script>
    <dt>&#123; escapedHtml &#125;</dt>
    <dd><code>{ escapedHtml }</code></dd>
    <dd><code data-value="{ '{ literalBraces }' }">{ literalBraces }</code></dd>`

		const parsed = parse(html)
		const code = compile(parsed, {
			root: '/',
			resolvePath: (v: string) => v,
			importer: '/',
		})
		const out = await execute(code)

		expect(out).toContain('<dt>{ escapedHtml }</dt>')
		expect(out).toContain('<code>&lt;em&gt;Escaped HTML&lt;/em&gt;</code>')
		expect(out).toContain('data-value="{ literalBraces }"')
		expect(out).not.toContain('[object Object]')
	})

	it('supports string expressions for literal braces in text content', async () => {
		const html = `<script is:build></script><p>{ '{ literal }' }</p>`
		const parsed = parse(html)
		const code = compile(parsed, {
			root: '/',
			resolvePath: (v: string) => v,
			importer: '/',
		})
		const out = await execute(code)
		expect(out).toBe('<p>{ literal }</p>')
	})
})
