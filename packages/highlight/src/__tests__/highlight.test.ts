import { describe, expect, it, beforeEach } from 'vitest'
import {
	highlight,
	getHighlighter,
	resetHighlighter,
	aeroHtml,
} from '../index'
import type { ShikiConfig } from '../types'

beforeEach(() => {
	resetHighlighter()
})

describe('getHighlighter', () => {
	it('creates a highlighter with single theme', async () => {
		const config: ShikiConfig = { theme: 'github-light' }
		const highlighter = await getHighlighter(config)

		expect(highlighter).toBeDefined()
		expect(typeof highlighter.codeToHtml).toBe('function')
	})

	it('creates a highlighter with multiple themes', async () => {
		const config: ShikiConfig = {
			themes: { light: 'github-light', dark: 'github-dark' },
		}
		const highlighter = await getHighlighter(config)

		expect(highlighter).toBeDefined()
		expect(typeof highlighter.codeToHtml).toBe('function')
	})

	it('caches highlighter across calls with same config', async () => {
		const config: ShikiConfig = { theme: 'github-light' }
		const h1 = await getHighlighter(config)
		const h2 = await getHighlighter(config)

		expect(h1).toBe(h2)
	})

	it('creates new highlighter when config changes', async () => {
		const h1 = await getHighlighter({ theme: 'github-light' })
		const h2 = await getHighlighter({ theme: 'nord' })

		expect(h1).not.toBe(h2)
	})

	it('uses default languages when none specified', async () => {
		const config: ShikiConfig = { theme: 'github-light' }
		const highlighter = await getHighlighter(config)

		// Should be able to highlight default languages without error
		const html = highlighter.codeToHtml('const x = 1', {
			lang: 'js',
			theme: 'github-light',
		})
		expect(html).toContain('const')
	})

	it('uses custom language list when specified', async () => {
		const config: ShikiConfig = {
			theme: 'github-light',
			langs: ['python'],
		}
		const highlighter = await getHighlighter(config)

		const html = highlighter.codeToHtml('def hello():\n    pass', {
			lang: 'python',
			theme: 'github-light',
		})
		expect(html).toContain('def')
	})

	it('supports langAlias', async () => {
		const config: ShikiConfig = {
			theme: 'github-light',
			langs: ['javascript'],
			langAlias: { 'my-js': 'javascript' },
		}
		const highlighter = await getHighlighter(config)

		const html = highlighter.codeToHtml('const x = 1', {
			lang: 'my-js',
			theme: 'github-light',
		})
		expect(html).toContain('const')
	})
})

describe('highlight', () => {
	it('highlights code with single theme', async () => {
		const html = await highlight('const x = 1', 'js', {
			theme: 'github-light',
		})

		expect(html).toContain('class="shiki')
		expect(html).toContain('const')
		expect(html).toContain('<pre')
		expect(html).toContain('<code')
	})

	it('highlights code with multiple themes', async () => {
		const html = await highlight('const x = 1', 'js', {
			themes: { light: 'github-light', dark: 'github-dark' },
		})

		expect(html).toContain('class="shiki')
		expect(html).toContain('--shiki-dark')
		expect(html).toContain('const')
	})

	it('highlights different languages', async () => {
		const htmlJs = await highlight('function foo() {}', 'js', {
			theme: 'github-light',
		})
		const htmlCss = await highlight('body { color: red; }', 'css', {
			theme: 'github-light',
		})

		expect(htmlJs).toContain('function')
		expect(htmlCss).toContain('body')
	})

	it('applies transformers', async () => {
		const { transformerNotationHighlight } = await import('@shikijs/transformers')

		const html = await highlight('const x = 1 // [!code highlight]', 'js', {
			theme: 'github-light',
			transformers: [transformerNotationHighlight()],
		})

		expect(html).toContain('class="shiki')
		// The transformer should add a highlighted class to the line
		expect(html).toContain('highlighted')
	})

	it('returns valid HTML structure', async () => {
		const html = await highlight('const x = 1', 'js', {
			theme: 'github-light',
		})

		// Should be a complete pre>code structure
		expect(html).toMatch(/<pre[^>]*>/)
		expect(html).toMatch(/<code>/)
		expect(html).toMatch(/<\/code>/)
		expect(html).toMatch(/<\/pre>/)
	})

	it('respects defaultColor option in multi-theme mode', async () => {
		const html = await highlight('const x = 1', 'js', {
			themes: { light: 'github-light', dark: 'github-dark' },
			defaultColor: false,
		})

		// With defaultColor: false, inline color should use CSS vars only
		expect(html).toContain('class="shiki')
		expect(html).toContain('--shiki-light')
		expect(html).toContain('--shiki-dark')
	})

	it('does not add data-lang by default', async () => {
		const html = await highlight('const x = 1', 'js', {
			theme: 'github-light',
		})

		expect(html).not.toContain('data-lang=')
	})

	it('does not add not-prose by default', async () => {
		const html = await highlight('const x = 1', 'js', {
			theme: 'github-light',
		})

		expect(html).not.toContain('not-prose')
	})

	it('highlights aero-html with JS expressions in attribute values', async () => {
		const code = '<my-component props="{ title: site.title, subtitle: site.tagline }" />'
		const html = await highlight(code, 'aero-html', {
			theme: 'github-light',
			langs: ['html', 'typescript', aeroHtml],
		})

		expect(html).toContain('class="shiki')
		expect(html).toContain('my-component')
		expect(html).toContain('props')
		// Expression content should be tokenized (e.g. title, site as separate spans)
		expect(html).toContain('title')
		expect(html).toContain('site')
	})

	it('highlights nested object interpolations in aero-html attributes', async () => {
		const code = '<section data-example="{{ foo: 1 }}"></section>'
		const html = await highlight(code, 'aero-html', {
			theme: 'github-light',
			langs: ['html', 'typescript', aeroHtml],
		})

		expect(html).toContain('class="shiki')
		expect(html).toContain('data-example')
		expect(html).toContain('foo')
		// Outer braces should be present as tokenized content (not stripped)
		expect(html).toMatch(/\{/)
		expect(html).toMatch(/\}/)
	})

	it('highlights via html alias', async () => {
		const code = '<div props="{ x: 1 }" />'
		const html = await highlight(code, 'html', {
			theme: 'github-light',
			langs: ['typescript', aeroHtml],
		})

		expect(html).toContain('class="shiki')
		expect(html).toContain('div')
	})
})

describe('resetHighlighter', () => {
	it('clears the cached instance', async () => {
		const config: ShikiConfig = { theme: 'github-light' }
		const h1 = await getHighlighter(config)

		resetHighlighter()

		const h2 = await getHighlighter(config)
		expect(h1).not.toBe(h2)
	})
})
