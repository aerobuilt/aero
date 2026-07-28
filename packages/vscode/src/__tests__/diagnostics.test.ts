/**
 * Unit tests for diagnostics orchestrator: unused/undefined variable reporting,
 * script tag validation (is:build, is:inline, type="module"), conditional chains
 * (if/else-if/else), directive brace requirements, duplicate declarations, and component
 * reference checks. Uses mocked vscode APIs and calls updateDiagnostics(doc) to assert reported diagnostics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import * as coreTemplateDiagnostics from '@aero-js/core/template-diagnostics'

const mockSet = vi.fn()
const mockCollection = {
	set: mockSet,
	delete: vi.fn(),
	dispose: vi.fn(),
}

vi.mock('vscode', () => {
	return {
		Range: class {
			start: any
			end: any
			constructor(start: any, end: any) {
				this.start = start
				this.end = end
			}
		},
		Position: class {
			line: any
			character: any
			constructor(line: any, character: any) {
				this.line = line
				this.character = character
			}
		},
		Diagnostic: class {
			range: any
			message: any
			severity: any
			tags: any[]
			constructor(range: any, message: any, severity: any) {
				this.range = range
				this.message = message
				this.severity = severity
				this.tags = []
			}
		},
		DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
		DiagnosticTag: { Unnecessary: 1 },
		workspace: {
			onDidOpenTextDocument: vi.fn(),
			onDidSaveTextDocument: vi.fn(),
			onDidChangeTextDocument: vi.fn(),
			onDidCloseTextDocument: vi.fn(),
			textDocuments: [],
			getWorkspaceFolder: vi.fn(),
			getConfiguration: () => ({
				get: () => undefined,
			}),
		},
		languages: {
			createDiagnosticCollection: () => mockCollection,
		},
		Uri: {
			parse: (s: string) => ({ toString: () => s, fsPath: s, scheme: 'file' }),
		},
	}
})

import { collectDiagnosticsForDocument } from '../diagnostics/index'

function runDiagnostics(doc: any): void {
	const diagnostics = collectDiagnosticsForDocument(doc)
	mockSet(doc.uri, diagnostics)
}

function positionAtOffset(text: string, offset: number): { line: number; character: number } {
	const lines = text.slice(0, offset).split('\n')
	return {
		line: lines.length - 1,
		character: lines[lines.length - 1]?.length ?? 0,
	}
}

function expectDiagnosticRange(
	text: string,
	diagnostic: any,
	expectedSubstring: string
): void {
	const startOffset = text.indexOf(expectedSubstring)
	expect(startOffset).toBeGreaterThanOrEqual(0)
	const endOffset = startOffset + expectedSubstring.length
	expect(diagnostic.range.start).toEqual(positionAtOffset(text, startOffset))
	expect(diagnostic.range.end).toEqual(positionAtOffset(text, endOffset))
}

describe('AeroDiagnostics orchestration', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('parses document once per diagnostics update', () => {
		const text = `
<script is:build>
	const title = 'hello'
</script>
<h1>{title}</h1>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		const collectSpy = vi.spyOn(coreTemplateDiagnostics, 'collectTemplateDiagnostics')
		runDiagnostics(doc)

		expect(collectSpy).toHaveBeenCalledTimes(1)
	})
})

/** Unused imports/vars: build scope vs bundled scope are separate; usage in template/Alpine/HTMX/getStaticPaths must count. */
describe('AeroDiagnostics Unused Variables', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should flag unused component import even if name exists in import path', () => {
		const text = `
<script is:build>
    import header from './header'
    // header is NOT used in template
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		expect(mockSet).toHaveBeenCalled()
		const reportedDiagnostics = mockSet.mock.calls[0][1]

		const unusedHeaderDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'header' is declared but its value is never read")
		)

		expect(unusedHeaderDiag).toBeDefined()
	})

	it('should NOT flag used component import', () => {
		const text = `
<script is:build>
    import header from './header'
</script>
<header-component />
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedHeaderDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'header' is declared but its value is never read")
		)
		expect(unusedHeaderDiag).toBeUndefined()
	})

	it('should NOT flag imports from is:build as unused when a client script block is also present', () => {
		const text = `
<script is:build>
  import base from '@layouts/base.html'
  import { render } from 'aero:content'
  const doc = Aero.props
  const { html } = await render(doc)
</script>
<base-layout title="{doc.data.title}">
  <section>{html}</section>
</base-layout>
<script>
  console.log('client side')
</script>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedDiags = reportedDiagnostics.filter((d: any) =>
			d.message.includes('is declared but its value is never read')
		)
		// render is used inside is:build (render(doc)) — should NOT be flagged
		// base is used as <base-layout> in template — should NOT be flagged
		// doc/html are used in template expressions
		expect(unusedDiags).toHaveLength(0)
	})

	it('should flag is:build import as unused even if the same name is declared in client script', () => {
		const text = `
<script is:build>
  import base from '@layouts/base.html'
</script>
<div>no template usage of base</div>
<script>
  const base = 'test'
  console.log(base)
</script>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedBaseDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'base' is declared but its value is never read")
		)
		expect(unusedBaseDiag).toBeDefined()
	})

	it('should flag unused build var whose initializer references a same-named property', () => {
		const text = `
<script is:build>
	import site from '@content/site.ts'
	const links = site.footer.links
</script>
<template for="{ const { path, label } of other }">
	<a href="{ path }">{ label }</a>
</template>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedLinksDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'links' is declared but its value is never read")
		)
		expect(unusedLinksDiag).toBeDefined()
	})

	it('should NOT flag build var used as a for-loop iterable', () => {
		const text = `
<script is:build>
	import site from '@content/site.ts'
	const links = site.footer.links
</script>
<template for="{ const { path, label } of links }">
	<a href="{ path }">{ label }</a>
</template>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedLinksDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'links' is declared but its value is never read")
		)
		expect(unusedLinksDiag).toBeUndefined()
	})

	it('should NOT flag variable as unused when used in Alpine x-data attribute', () => {
		const text = `
<script is:build>
	const dismiss = el => setTimeout(() => el.replaceChildren(), 3000)
</script>
<section x-data="{input: '', dismiss: dismiss}">
	<span @click="dismiss($el)">Click me</span>
</section>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedDismissDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'dismiss' is declared but its value is never read")
		)
		expect(unusedDismissDiag).toBeUndefined()
	})

	it('should NOT flag destructured bindings with defaults as unused when used in template', () => {
		const text = `
<script is:build>
	const { meta } = site
	const {
		title = meta.title,
		description = meta.description,
		image = Aero.site.url + meta.ogImage,
	} = Aero.props
</script>
<title>{ title }</title>
<meta name="description" content="{ description }" />
<meta property="og:image" content="{ image }" />
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
			offsetAt: (pos: any) => (typeof pos.character === 'number' ? pos.character : 0),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		for (const name of ['title', 'description', 'image']) {
			const unusedDiag = reportedDiagnostics.find((d: any) =>
				d.message.includes(`'${name}' is declared but its value is never read`)
			)
			expect(unusedDiag).toBeUndefined()
		}
	})

	it('should NOT flag variable as unused when used in HTMX event handler', () => {
		const text = `
<script is:build>
	const dismiss = el => setTimeout(() => el.replaceChildren(), 3000)
</script>
<span @htmx:after-swap="dismiss($el)"></span>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedDismissDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'dismiss' is declared but its value is never read")
		)
		expect(unusedDismissDiag).toBeUndefined()
	})

	it('should NOT flag getCollection when used in getStaticPaths', () => {
		const text = `
<script is:build>
    import { getCollection } from 'aero:content'
    
    export async function getStaticPaths() {
        const posts = await getCollection('posts')
        return posts.map(post => ({ params: { slug: post.slug } }))
    }
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'getCollection' is declared but its value is never read")
		)
		expect(unusedDiag).toBeUndefined()
	})

	it('should NOT flag getStaticPaths as unused (build-time export)', () => {
		const text = `
<script is:build>
    import { getCollection, render } from 'aero:content'

    export async function getStaticPaths() {
        const docs = await getCollection('docs')
        return docs.map(doc => ({
            params: { slug: doc.id },
            props: doc,
        }))
    }

    const doc = Aero.props
    const { html } = await render(doc)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedGsp = reportedDiagnostics.find((d: any) =>
			d.message.includes("'getStaticPaths' is declared but its value is never read")
		)
		expect(unusedGsp).toBeUndefined()
	})

	it('should NOT flag build-scope variables as unused when passed via props', () => {
		const text = `
<script is:build>
	const { storageKey, attribute } = site.theme
</script>
<script props="{ storageKey, attribute }">
	const theme = JSON.parse(localStorage.getItem(storageKey))
	document.documentElement.setAttribute(attribute, theme)
</script>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
			offsetAt: (pos: any) => (typeof pos.character === 'number' ? pos.character : 0),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const unusedStorageKey = reportedDiagnostics.find((d: any) =>
			d.message.includes("'storageKey' is declared but its value is never read")
		)
		const unusedAttribute = reportedDiagnostics.find((d: any) =>
			d.message.includes("'attribute' is declared but its value is never read")
		)
		expect(unusedStorageKey).toBeUndefined()
		expect(unusedAttribute).toBeUndefined()
	})

	it('should NOT flag props-injected variables as unused in is:inline scripts', () => {
		const text = `<script is:build>
	const isHomepage = Aero.page.url.pathname === '/'
</script>
<script is:inline props="{ isHomepage }">
	console.debug('[aero] isHomepage', isHomepage)
</script>`
		const doc = {
			uri: {
				toString: () => 'file:///header.html',
				fsPath: '/header.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/header.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const unusedIsHomepage = reportedDiagnostics.find((d: any) =>
			d.message.includes("'isHomepage' is declared but its value is never read")
		)
		expect(unusedIsHomepage).toBeUndefined()
	})

	it('should NOT flag render when used in getStaticPaths', () => {
		const text = `
<script is:build>
    import { getCollection, render } from 'aero:content'
    
    export async function getStaticPaths() {
        const posts = await getCollection('posts')
        return posts.map(post => {
            const content = render(post)
            return { params: { slug: post.slug }, props: { content } }
        })
    }
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const unusedRenderDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'render' is declared but its value is never read")
		)
		const unusedCollectionDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'getCollection' is declared but its value is never read")
		)

		expect(unusedRenderDiag).toBeUndefined()
		expect(unusedCollectionDiag).toBeUndefined()
	})

	it('should NOT flag build-scope const as unused when referenced from is:state', () => {
		const text = `<script is:build>
	const initialItems = [{ id: 'a' }, { id: 'b' }]
</script>

<script is:state>
	let items = initialItems
</script>

<ul>
	<li for="{ const item of items }" key="{ item.id }">{ item.id }</li>
</ul>
`
		const doc = {
			uri: {
				toString: () => 'file:///keyed-list.html',
				fsPath: '/keyed-list.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => positionAtOffset(text, offset),
			languageId: 'html',
			fileName: '/keyed-list.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const unusedInitialItems = reportedDiagnostics.find((d: any) =>
			d.message.includes("'initialItems' is declared but its value is never read")
		)
		expect(unusedInitialItems).toBeUndefined()
	})

	it('should NOT flag is:state bindings as unused when used in template or event handlers', () => {
		const text = `<script is:build>
	import base from '@layouts/base.html'
</script>

<script is:state>
	let count = 0

	const inc = () => count++
	const dec = () => count--
</script>

<base-layout title="Reactivity Demo">
	<p>Count: <strong>{ count }</strong></p>
	<button on:click="{ inc() }">+1</button>
	<button on:click="{ dec() }">-1</button>
</base-layout>
`
		const doc = {
			uri: {
				toString: () => 'file:///counter.html',
				fsPath: '/counter.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/counter.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		for (const name of ['count', 'inc', 'dec']) {
			const unusedDiag = reportedDiagnostics.find((d: any) =>
				d.message.includes(`'${name}' is declared but its value is never read`)
			)
			expect(unusedDiag).toBeUndefined()
		}
	})

	it('should still flag unused bundled script vars that share a template name from build scope', () => {
		const text = `<script is:build>
	const title = 'Build title'
</script>
<script>
	const title = 'Unused client copy'
</script>
<h1>{ title }</h1>
`
		const doc = {
			uri: {
				toString: () => 'file:///page.html',
				fsPath: '/page.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/page.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const unusedClientTitle = reportedDiagnostics.find((d: any) =>
			d.message.includes("'title' is declared but its value is never read")
		)
		expect(unusedClientTitle).toBeDefined()
	})
})

/** Undefined refs in template expressions; content globals (e.g. site) and Alpine x-data are excluded. */
describe('AeroDiagnostics Undefined Variables', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('does not emit Aero Variable diagnostics for undefined template refs (TS2304 covers them)', () => {
		const text = `
<script is:build></script>
<div>{undefinedVar}</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const undefinedDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'undefinedVar' is not defined")
		)
		expect(undefinedDiag).toBeUndefined()
	})

	it('should NOT flag false keyword as undefined', () => {
		const text = `
<div>{ false }</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const falseDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'false' is not defined")
		)
		expect(falseDiag).toBeUndefined()
	})

	it('should NOT flag defined variable in template expression', () => {
		const text = `
<script is:build>
	const myVar = 'hello'
</script>
<div>{myVar}</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const undefinedDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'myVar' is not defined")
		)
		expect(undefinedDiag).toBeUndefined()
	})

	it('should NOT flag for loop bindings and injected loop metadata', () => {
		const text = `
<script is:build>
	const links = [{ path: '/', label: 'Home' }]
</script>
<ul>
	<li for="{ const link of links }" class="{ first ? 'is-first' : '' }">
		{ link.path } { index } { last } { length }
	</li>
</ul>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const undefinedVarDiags = reportedDiagnostics.filter(
			(d: any) => d.message.includes('is not defined') && d.message.includes('Variable')
		)
		expect(undefinedVarDiags).toHaveLength(0)
	})

	it('should NOT flag raw() when argument is defined in build script', () => {
		const text = `
<script is:build>
	const html = '<strong>x</strong>'
</script>
<p>{ raw(html) }</p>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const undefinedVarDiags = reportedDiagnostics.filter(
			(d: any) => d.message.includes('is not defined') && d.message.includes('Variable')
		)
		expect(undefinedVarDiags).toHaveLength(0)
	})

	it('does not emit Aero Variable diagnostics for missing build-script imports (TS2304 covers them)', () => {
		const text = `
<script is:build>
	//import site from '@content/site.ts'
	const headerProps = { title: site.home.title, subtitle: site.home.subtitle }
</script>
<div/>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const siteDiag = reportedDiagnostics.filter((d: any) =>
			d.message.includes("'site' is not defined")
		)
		expect(siteDiag).toHaveLength(0)
	})

	it('should NOT flag content global in build script when imported', () => {
		const text = `
<script is:build>
	import site from '@content/site.ts'
	const headerProps = { title: site.home.title }
</script>
<div/>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const siteDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'site' is not defined")
		)
		expect(siteDiag).toBeUndefined()
	})

	it('does not emit Aero Variable diagnostics for missing is:state handlers (TS2304 covers them)', () => {
		const text = `<script is:build>
	import base from '@layouts/base.html'
</script>

<script is:state>
	let count = 0

	//const inc = () => count++
	//const dec = () => count--
</script>

<base-layout title="Reactivity Demo">
	<p>Count: <strong>{ count }</strong></p>
	<button on:click="{ inc() }">+1</button>
	<button on:click="{ dec() }">-1</button>
</base-layout>
`
		const doc = {
			uri: {
				toString: () => 'file:///counter.html',
				fsPath: '/counter.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/counter.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		for (const name of ['inc', 'dec']) {
			const undefinedDiag = reportedDiagnostics.find((d: any) =>
				d.message.includes(`'${name}' is not defined`)
			)
			expect(undefinedDiag).toBeUndefined()
		}
	})

	it('does not emit Aero Variable diagnostics for unimported content globals in templates (TS2304 covers them)', () => {
		const text = `
<script is:build></script>
<div>{site.title}</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const undefinedDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'site' is not defined")
		)
		expect(undefinedDiag).toBeUndefined()
	})

	it('does not emit Aero Variable diagnostics for missing for-loop iterables (TS2304 covers them)', () => {
		const text = `<script is:build>
	import base from '@layouts/base.html'
	//import site from '@content/site'
</script>
<div for="{ const demo of site }">
	<a href="{ demo.href }">{ demo.label }</a>
</div>`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const siteDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'site' is not defined")
		)
		expect(siteDiag).toBeUndefined()
	})

	it('should NOT flag undefined variable in Alpine x-data', () => {
		const text = `
<section x-data="{ input: '' }">
	<input x-model="input" />
</section>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const undefinedDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'input' is not defined")
		)
		expect(undefinedDiag).toBeUndefined()
	})
})

/** Script tag rules: plain/is:build valid; is:inline import requires type="module"; comments ignored. */
describe('AeroDiagnostics Script Tags', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should NOT warn when plain script tag (no attribute) — bundled as module by default', () => {
		const text = `
<script>
	const foo = 'bar'
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const scriptDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('<script> without attribute')
		)
		expect(scriptDiag).toBeUndefined()
	})

	it('should NOT warn when script has is:build', () => {
		const text = `
<script is:build>
	const foo = 'bar'
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const scriptDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('<script> without attribute')
		)
		expect(scriptDiag).toBeUndefined()
	})

	it('should warn when is:inline script has import without type="module"', () => {
		const text = `
<script is:inline>
	import { foo } from 'bar'
	console.log(foo)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in <script is:inline> require type="module"')
		)
		expect(importDiag).toBeDefined()
	})

	it('should NOT warn when is:inline script has import WITH type="module"', () => {
		const text = `
<script is:inline type="module">
	import { foo } from 'bar'
	console.log(foo)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in <script is:inline>')
		)
		expect(importDiag).toBeUndefined()
	})

	it('should NOT warn when is:inline script has import with TYPE="module" (attribute case-insensitive)', () => {
		const text = `
<script is:inline TYPE="module">
	import { foo } from 'bar'
	console.log(foo)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in <script is:inline>')
		)
		expect(importDiag).toBeUndefined()
	})

	it('should NOT warn when plain script has import — bundled as module by default', () => {
		const text = `
<script>
	import { foo } from 'bar'
	console.log(foo)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in bundled scripts')
		)
		expect(importDiag).toBeUndefined()
	})

	it('should NOT warn when props script has import (Vite handles bundling)', () => {
		const text = `
<script props="{ foo }">
	import { bar } from 'baz'
	console.log(bar)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in bundled scripts')
		)
		expect(importDiag).toBeUndefined()
	})

	it('should NOT warn when bundled script has import WITH type="module"', () => {
		const text = `
<script type="module">
	import { foo } from 'bar'
	console.log(foo)
</script>
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in bundled scripts')
		)
		expect(importDiag).toBeUndefined()
	})

	it('should NOT flag scripts inside HTML comments', () => {
		const text = `
<!--<script>
	import { foo } from 'bar'
</script>-->
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		// Should not flag duplicate imports from commented script
		const dupDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('declared multiple times')
		)
		expect(dupDiag).toBeUndefined()
	})

	it('should NOT flag duplicate when commented script has same import as real script', () => {
		const text = `
<script is:build>
	import { allCaps } from '@scripts/utils'
</script>
<!--<script>
	import { allCaps } from '@scripts/utils'
</script>-->
<div></div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const dupDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('declared multiple times')
		)
		expect(dupDiag).toBeUndefined()
	})

	it('should warn when is:inline has import in multi-script file structure', () => {
		const text = `
<script is:build>
	import base from '@layouts/base.html'
	import header from '@components/header.html'
</script>
<base-layout>
	<header-component />
</base-layout>
<script is:inline>
	console.log('first inline')
</script>
<script is:inline>
	import { allCaps } from '@scripts/utils'
	console.log(allCaps('test'))
</script>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const importDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('Imports in <script is:inline>')
		)
		expect(importDiag).toBeDefined()
	})
})

/** else-if and aero-else must follow an element with if or else-if. */
describe('AeroDiagnostics Conditional Chains', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should flag orphaned else-if without preceding if', () => {
		const text = `
<div>Before</div>
<div else-if="{condition}">Else If</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const elseIfDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('else-if must follow an element with if or else-if')
		)
		expect(elseIfDiag).toBeDefined()
	})

	it('should flag orphaned else without preceding if', () => {
		const text = `
<div>Before</div>
<div aero-else>Else</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const elseDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('else must follow an element with if or else-if')
		)
		expect(elseDiag).toBeDefined()
	})

	it('should NOT flag valid if-else-if-else chain', () => {
		const text = `
<div if="{a}">A</div>
<div else-if="{b}">B</div>
<div aero-else>C</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const conditionalDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('must follow an element with if or else-if')
		)
		expect(conditionalDiag).toBeUndefined()
	})
})

/** Directives (if, for, etc.) must use braced expressions (e.g. if="{ cond }"). */
describe('AeroDiagnostics Directive Expression Braces', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should flag directive without braced expression', () => {
		const text = `
<div if="condition">Content</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const directiveDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('must use a braced expression')
		)
		expect(directiveDiag).toBeDefined()
		expect(directiveDiag.code.value).toBe('AERO_COMPILE')
		expect(String(directiveDiag.code.target)).toContain('concepts/templating.mdx')
	})

	it('should NOT flag directive with braced expression', () => {
		const text = `
<div if="{condition}">Content</div>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const directiveDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('must use a braced expression')
		)
		expect(directiveDiag).toBeUndefined()
	})

	const makeDoc = (text: string) =>
		({
			uri: { toString: () => 'file:///test.html', fsPath: '/test.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		}) as any

	const findBraceDiag = () =>
		mockSet.mock.calls[0][1].find((d: any) =>
			d.message.includes('must use a braced expression')
		)

	it('should NOT flag bare for on <label> (native HTML attribute)', () => {
		runDiagnostics(makeDoc(`\n<label for="email">Email</label>\n`))
		expect(findBraceDiag()).toBeUndefined()
	})

	it('should NOT flag bare for on <output> (native HTML attribute)', () => {
		runDiagnostics(makeDoc(`\n<output for="a b">x</output>\n`))
		expect(findBraceDiag()).toBeUndefined()
	})

	it('should still flag a forgotten-brace loop (bare for on a non-native element)', () => {
		runDiagnostics(makeDoc(`\n<li for="const item of items">x</li>\n`))
		expect(findBraceDiag()).toBeDefined()
	})

	it('should still flag explicit aero-for on <label> (always a directive)', () => {
		runDiagnostics(makeDoc(`\n<label aero-for="email">x</label>\n`))
		expect(findBraceDiag()).toBeDefined()
	})

	it('should flag event directive without braced expression', () => {
		runDiagnostics(makeDoc(`\n<button on:click="submit()">Save</button>\n`))
		expect(findBraceDiag()).toBeDefined()
	})

	it('should flag malformed event directive modifier chain', () => {
		runDiagnostics(makeDoc(`\n<button on:click..prevent="{ submit() }">Save</button>\n`))
		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const invalidDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('is invalid:')
		)
		expect(invalidDiag).toBeDefined()
		expect(invalidDiag.code.value).toBe('AERO_COMPILE')
	})

	it('should NOT flag HTMX hx-on event attributes as Aero on:* directives', () => {
		runDiagnostics(
			makeDoc(
				`\n<form hx-post="/api/submit" hx-on::after-request="if (event.detail.successful) this.reset()"></form>\n`
			)
		)
		expect(findBraceDiag()).toBeUndefined()
	})

	it('should flag event directive without braced expression on multiline tag', () => {
		runDiagnostics(
			makeDoc(`<button
  on:click="
    submit()
  "
>Save</button>`)
		)
		expect(findBraceDiag()).toBeDefined()
	})

	it('should NOT flag native for on multiline label tag', () => {
		runDiagnostics(
			makeDoc(`<label
  for="email"
>Email</label>`)
		)
		expect(findBraceDiag()).toBeUndefined()
	})
})

/** Same name declared in same scope (e.g. import + const) → "declared multiple times". */
describe('AeroDiagnostics Duplicate Declarations', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should flag import conflicting with local declaration', () => {
		const text = `
<script is:build>
	import header from '@components/header.html'
	const header = { title: 'Test' }
</script>
<header-component />
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const dupDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('declared multiple times')
		)
		expect(dupDiag).toBeDefined()
	})

	it('should NOT flag when no duplicate', () => {
		const text = `
<script is:build>
	import header from '@components/header.html'
	const props = { title: 'Test' }
</script>
<header-component />
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1]
		const dupDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('declared multiple times')
		)
		expect(dupDiag).toBeUndefined()
	})

	it('should NOT flag arrow param shadowing module-level const with same name', () => {
		const text = `
<script is:build>
	import base from '@layouts/base.html'
	import { getCollection, render } from 'aero:content'

	export async function getStaticPaths() {
		const docs = await getCollection('docs')
		return docs.map(doc => ({
			params: { slug: doc.id },
			props: doc,
		}))
	}

	const doc = Aero.props
	const { html } = await render(doc)
</script>
<base-layout title="{ doc.data.title }" />
`
		const doc = {
			uri: {
				toString: () => 'file:///docs/slug.html',
				fsPath: '/docs/slug.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/docs/slug.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const dupDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'doc'") && d.message.includes('declared multiple times')
		)
		expect(dupDiag).toBeUndefined()
	})
})

/** Component usage in template must have matching import; strings inside client scripts are ignored. */
describe('AeroDiagnostics Component References', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should NOT flag layout/component tags as "not imported" when they are imported in <script is:build>', () => {
		const text = `<script is:build>
	import base from '@layouts/base.html'
	import header from '@components/header.html'
	import form from '@components/form.html'
</script>
<base-layout>
	<header-component />
	<form-component />
</base-layout>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
			offsetAt: (pos: any) => (typeof pos.character === 'number' ? pos.character : 0),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const notImported = reportedDiagnostics.filter((d: any) =>
			d.message.includes('is not imported')
		)
		expect(notImported).toHaveLength(0)
	})

	it('should flag extensionless template imports and treat layout usage as not imported', () => {
		const text = `<script is:build>
	import base from '@layouts/base'
</script>
<base-layout />
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => positionAtOffset(text, offset),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
			offsetAt: (pos: any) => (typeof pos.character === 'number' ? pos.character : 0),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const missingExtension = reportedDiagnostics.find((d: any) =>
			d.message.includes('Template imports must include the .html extension')
		)
		const notImported = reportedDiagnostics.find((d: any) =>
			d.message.includes("Component 'base' is not imported")
		)
		expect(missingExtension).toBeDefined()
		expect(notImported).toBeDefined()
	})

	it('should underline only the tag name when a component is not imported', () => {
		const text = `<missing-component />`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => positionAtOffset(text, offset),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const notImported = reportedDiagnostics.find((d: any) =>
			d.message.includes("Component 'missing' is not imported")
		)
		expect(notImported).toBeDefined()
		expectDiagnosticRange(text, notImported, '<missing-component')
	})

	it('should ignore components inside client scripts', () => {
		const text = `
<script>
	const tag = "<header-component>"
</script>
`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0][1] || []
		const componentDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes('is not imported')
		)
		expect(componentDiag).toBeUndefined()
	})

	it('should ignore component-like markup inside template literal snippets', () => {
		const text = `<script is:state>
	const { count = Aero.bindable() } = Aero.props
</script>
<code>{ \`<header-component bind:count="{ \${count} }" />\` }</code>`
		const doc = {
			uri: {
				toString: () => 'file:///test.html',
				fsPath: '/test.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => positionAtOffset(text, offset),
			languageId: 'html',
			fileName: '/test.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const headerDiags = reportedDiagnostics.filter(
			(d: any) =>
				d.message.includes('header') &&
				(d.message.includes('not imported') ||
					d.message.includes('not defined') ||
					d.message.includes('is not defined'))
		)
		expect(headerDiags).toHaveLength(0)
	})

	it('should not run template diagnostics on content/snippets modules', () => {
		const text = `<!-- @snippet:propsString -->
<greeting-component name="Aero" />
`
		const doc = {
			uri: {
				toString: () => 'file:///app/content/snippets/markup.html',
				fsPath: '/app/content/snippets/markup.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => positionAtOffset(text, offset),
			languageId: 'html',
			fileName: '/app/content/snippets/markup.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		expect(reportedDiagnostics).toHaveLength(0)
	})
})

/** Cross-file prop validation: report when required props are missing. */
describe('AeroDiagnostics Component Props', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	it('should report missing required prop when props="{ ...varName }" omits it', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-props-'))
		try {
			const compPath = path.join(dir, 'req-field.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:build lang="ts">
export interface ReqFieldProps { title: string; reqFlag: boolean }
const _p = Aero.props as ReqFieldProps
</script>
<p>{ _p.title }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build lang="ts">
import reqField from './req-field.html'
const spread = { title: 'hello' }
</script>
<req-field-component props="{ ...spread }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const missing = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes("Missing required prop 'reqFlag'") &&
					d.message.includes('req-field-component')
			)
			expect(missing).toBeDefined()
			expect(missing.code.value).toBe('AERO_COMPILE')
			expect(String(missing.code.target)).toContain('data/props.mdx')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report omitted required reactive props for imported components', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count } = Aero.props
</script>
<p>{ count }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const missing = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes('Required reactive prop `count`') &&
					d.message.includes('<counter-component>')
			)
			expect(missing).toBeDefined()
			expect(missing.code.value).toBe('AERO_COMPILE')
			expectDiagnosticRange(pageText, missing, '<counter-component')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should not report required reactive props when passed as state signals', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-ok-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count } = Aero.props
</script>
<p>{ count }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component count="{ count }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const missing = reportedDiagnostics.find((d: any) =>
				d.message.includes('Required reactive prop `count`')
			)
			expect(missing).toBeUndefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report obsolete readonly reactive prop syntax', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-readonly-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count } = Aero.props
</script>
<p>{ count }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component count:readonly="{ count }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const readonly = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes('Component reactive prop `count:readonly` is obsolete')
			)
			expect(readonly).toBeDefined()
			expect(readonly.code.value).toBe('AERO_COMPILE')
			expectDiagnosticRange(pageText, readonly, 'count:readonly="{ count }"')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report bind reactive props when child prop is not bindable', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-bind-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count } = Aero.props
</script>
<p>{ count }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component bind:count="{ count }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const bind = reportedDiagnostics.find((d: any) =>
				d.message.includes('must be declared with `Aero.bindable()`')
			)
			expect(bind).toBeDefined()
			expect(bind.code.value).toBe('AERO_COMPILE')
			expectDiagnosticRange(pageText, bind, 'bind:count="{ count }"')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report bind when child uses undestructured Aero.props bag', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-bag-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const props = Aero.props
</script>
<p>{ props.count }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component bind:count="{ count }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const bind = reportedDiagnostics.find((d: any) =>
				d.message.includes('must be declared with `Aero.bindable()`')
			)
			expect(bind).toBeDefined()
			expect(bind.code.value).toBe('AERO_COMPILE')
			expectDiagnosticRange(pageText, bind, 'bind:count="{ count }"')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report bind when bind name is not a known bindable child prop', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-unknown-bind-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { value = Aero.bindable(0) } = Aero.props
</script>
<p>{ value }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component bind:count="{ count }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const bind = reportedDiagnostics.find((d: any) =>
				d.message.includes('must be declared with `Aero.bindable()`') &&
				d.message.includes('`count`')
			)
			expect(bind).toBeDefined()
			expect(bind.code.value).toBe('AERO_COMPILE')
			expectDiagnosticRange(pageText, bind, 'bind:count="{ count }"')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report plain reactive props when the child declares them bindable', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-write-'))
		try {
			const compPath = path.join(dir, 'counter.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count = Aero.bindable(0) } = Aero.props
function inc() { count++ }
</script>
<button on:click="{ inc() }">{ count }</button>
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import counter from './counter.html'
</script>
<script is:state>
let count = 1
</script>
<counter-component count="{ count }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const readonly = reportedDiagnostics.find((d: any) =>
				d.message.includes('must be passed with `bind:count="{ ... }"`')
			)
			expect(readonly).toBeDefined()
			expect(readonly.code.value).toBe('AERO_COMPILE')
			expectDiagnosticRange(pageText, readonly, 'count="{ count }"')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should explain how to bind when a child mutates a readonly reactive prop', () => {
		const text = `<script is:state>
const { count } = Aero.props
</script>
<button on:click="{ count++ }">{ count }</button>
`
		const doc = {
			uri: {
				toString: () => 'file:///counter.html',
				fsPath: '/counter.html',
				scheme: 'file',
			},
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return {
					line: lines.length - 1,
					character: lines[lines.length - 1]?.length ?? 0,
				}
			},
			languageId: 'html',
			fileName: '/counter.html',
			lineAt: (line: number) => ({
				text: text.split('\n')[line] ?? '',
			}),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const readonly = reportedDiagnostics.find((d: any) =>
			d.message.includes(
				'Reactive prop `count` is readonly; declare it with `Aero.bindable()` in the child and pass it with `bind:count="{ ... }"` from the parent to allow mutation.'
			)
		)
		expect(readonly).toBeDefined()
		expect(readonly.code.value).toBe('AERO_COMPILE')
	})

	it('should not report readonly bind for reactive props with destructuring defaults only', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-reactive-props-defaults-'))
		try {
			const compPath = path.join(dir, 'numeric-text.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const {
	value = Aero.bindable(0),
	animated = true,
	trend = 0,
	respectMotionPreference = true,
} = Aero.props
</script>
<numeric-text />
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import numericText from './numeric-text.html'
</script>
<script is:state>
let count = 0
let animated = false
let trend = 1
let respectMotionPreference = true
</script>
<numeric-text-component
	bind:value="{ count }"
	animated="{ animated }"
	trend="{ trend }"
	respectMotionPreference="{ respectMotionPreference }" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const readonly = reportedDiagnostics.find((d: any) =>
				d.message.includes('is readonly; use `bind:')
			)
			expect(readonly).toBeUndefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report missing required prop when bare props omits it', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-props-bare-'))
		try {
			const compPath = path.join(dir, 'req-field.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:build lang="ts">
export interface ReqFieldProps { title: string; reqFlag: boolean }
const _p = Aero.props as ReqFieldProps
</script>
<p>{ _p.title }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build lang="ts">
import reqField from './req-field.html'
const props = { title: 'hello' }
</script>
<req-field-component props />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const missing = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes("Missing required prop 'reqFlag'") &&
					d.message.includes('req-field-component')
			)
			expect(missing).toBeDefined()
			expect(missing.code.value).toBe('AERO_COMPILE')
			expect(String(missing.code.target)).toContain('data/props.mdx')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should not report when bare props includes all required fields', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-props-bare-ok-'))
		try {
			const compPath = path.join(dir, 'req-field.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:build lang="ts">
export interface ReqFieldProps { title: string; reqFlag: boolean }
const _p = Aero.props as ReqFieldProps
</script>
<p>{ _p.title }</p>
`,
				'utf-8'
			)
			const pageText = `<script is:build lang="ts">
import reqField from './req-field.html'
const props = { title: 'hello', reqFlag: true }
</script>
<req-field-component props />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const missing = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes('Missing required prop') && d.message.includes('req-field-component')
			)
			expect(missing).toBeUndefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report missing required prop when bare layout props omits sink field', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-layout-props-bare-'))
		try {
			const sinkPath = path.join(dir, 'sink.html')
			const midPath = path.join(dir, 'mid.html')
			const pagePath = path.join(dir, 'nest.html')
			fs.writeFileSync(
				sinkPath,
				`<script is:build lang="ts">
export interface SinkProps { alpha: string; beta: string }
const _ = Aero.props as SinkProps
</script>
<div/>
`,
				'utf-8'
			)
			fs.writeFileSync(
				midPath,
				`<script is:build>
import sink from './sink.html'
</script>
<sink-component props="{ ...Aero.props }" />
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import mid from './mid.html'
const props = { alpha: 'x' }
</script>
<mid-layout props />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const layoutDiag = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes("Missing required prop 'beta'") && d.message.includes('mid-layout')
			)
			expect(layoutDiag).toBeDefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('should report missing required prop when layout attributes flow to sink component', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-layout-props-'))
		try {
			const sinkPath = path.join(dir, 'sink.html')
			const midPath = path.join(dir, 'mid.html')
			const pagePath = path.join(dir, 'nest.html')
			fs.writeFileSync(
				sinkPath,
				`<script is:build lang="ts">
export interface SinkProps { alpha: string; beta: string }
const _ = Aero.props as SinkProps
</script>
<div/>
`,
				'utf-8'
			)
			fs.writeFileSync(
				midPath,
				`<script is:build>
import sink from './sink.html'
</script>
<sink-component props="{ ...Aero.props }" />
`,
				'utf-8'
			)
			const pageText = `<script is:build>
import mid from './mid.html'
</script>
<mid-layout alpha="x" />
`
			fs.writeFileSync(pagePath, pageText, 'utf-8')
			const doc = {
				uri: {
					toString: () => `file://${pagePath}`,
					fsPath: pagePath,
					scheme: 'file',
				},
				getText: () => pageText,
				positionAt: (offset: number) => {
					const lines = pageText.slice(0, offset).split('\n')
					return {
						line: lines.length - 1,
						character: lines[lines.length - 1]?.length ?? 0,
					}
				},
				languageId: 'html',
				fileName: pagePath,
				lineAt: (line: number) => ({
					text: pageText.split('\n')[line] ?? '',
				}),
			} as any

			runDiagnostics(doc)

			const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
			const layoutDiag = reportedDiagnostics.find(
				(d: any) =>
					d.message.includes("Missing required prop 'beta'") && d.message.includes('mid-layout')
			)
			expect(layoutDiag).toBeDefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})

/** Script props: client script globals require props attribute injection. */
describe('AeroDiagnostics Script props variables', () => {
	beforeEach(() => {
		mockSet.mockClear()
	})

	const baseFixture = (withProps: boolean) => `
<script is:build>
	const { storageKey, attribute } = site.theme
</script>
<script${withProps ? ' props="{ storageKey, attribute }"' : ''}>
	const theme = JSON.parse(localStorage.getItem(storageKey))
	document.documentElement.setAttribute(attribute, theme)
</script>
`

	it('reports undefined when client script uses build vars without props', () => {
		const text = baseFixture(false)
		const doc = {
			uri: { toString: () => 'file:///base.html', fsPath: '/base.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/base.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const storageKeyDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'storageKey' is not defined")
		)
		const attributeDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'attribute' is not defined")
		)
		expect(storageKeyDiag).toBeDefined()
		expect(attributeDiag).toBeDefined()
	})

	it('does not report when props injects build-scope values', () => {
		const text = baseFixture(true)
		const doc = {
			uri: { toString: () => 'file:///base.html', fsPath: '/base.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/base.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const scriptBodyDiag = reportedDiagnostics.find(
			(d: any) =>
				d.message.includes('is not defined') &&
				(d.message.includes('storageKey') || d.message.includes('attribute'))
		)
		expect(scriptBodyDiag).toBeUndefined()
	})

	it('reports unknown identifier in props expression', () => {
		const text = `
<script is:build>
	const known = 1
</script>
<script props="{ unknownVar }">
	console.debug(unknownVar)
</script>
`
		const doc = {
			uri: { toString: () => 'file:///page.html', fsPath: '/page.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/page.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const propsExprDiag = reportedDiagnostics.find((d: any) =>
			d.message.includes("'unknownVar' is not defined")
		)
		expect(propsExprDiag).toBeDefined()
	})

	it('supports bare props on script spreading build-scope props object', () => {
		const withProps = `
<script is:build>
	const props = { token: 'abc' }
</script>
<script props>
	console.debug(token)
</script>
`
		const withoutProps = `
<script is:build>
	const props = { token: 'abc' }
</script>
<script>
	console.debug(token)
</script>
`
		const docWith = {
			uri: { toString: () => 'file:///with.html', fsPath: '/with.html', scheme: 'file' },
			getText: () => withProps,
			positionAt: (offset: number) => {
				const lines = withProps.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/with.html',
			lineAt: (line: number) => ({ text: withProps.split('\n')[line] ?? '' }),
		} as any
		const docWithout = {
			uri: { toString: () => 'file:///without.html', fsPath: '/without.html', scheme: 'file' },
			getText: () => withoutProps,
			positionAt: (offset: number) => {
				const lines = withoutProps.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/without.html',
			lineAt: (line: number) => ({ text: withoutProps.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(docWith)
		const withDiags = mockSet.mock.calls[0]?.[1] ?? []
		expect(withDiags.find((d: any) => d.message.includes("'token' is not defined"))).toBeUndefined()

		mockSet.mockClear()
		runDiagnostics(docWithout)
		const withoutDiags = mockSet.mock.calls[0]?.[1] ?? []
		expect(withoutDiags.find((d: any) => d.message.includes("'token' is not defined"))).toBeDefined()
	})

	it('does not flag arrow params or for-of bindings in client scripts', () => {
		const text = `
<script>
	const linksById = new Map(
		[...document.querySelectorAll('[data-toc-link]')]
			.map(link => [link.hash.slice(1), link])
			.filter(([id]) => id)
	)
	for (const heading of [...linksById.keys()]) {
		if (!heading.id) continue
		break
	}
</script>
`
		const doc = {
			uri: { toString: () => 'file:///toc.html', fsPath: '/toc.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/toc.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const falsePositives = reportedDiagnostics.filter(
			(d: any) =>
				d.message.includes('is not defined') &&
				(d.message.includes("'link'") ||
					d.message.includes("'id'") ||
					d.message.includes("'heading'") ||
					d.message.includes("'new'") ||
					d.message.includes("'for'") ||
					d.message.includes("'continue'") ||
					d.message.includes("'break'"))
		)
		expect(falsePositives).toEqual([])
	})

	it('does not flag JS keywords in client scripts (toc pattern)', () => {
		const cwdPath = path.join(process.cwd(), 'website/client/components/toc.html')
		const repoRootPath = path.join(process.cwd(), '../../website/client/components/toc.html')
		const tocPath = fs.existsSync(cwdPath) ? cwdPath : repoRootPath
		const text = fs.readFileSync(tocPath, 'utf8')
		const doc = {
			uri: { toString: () => 'file:///toc.html', fsPath: '/toc.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/toc.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const scriptUndefinedDiags = reportedDiagnostics.filter(
			(d: any) =>
				d.message.includes('is not defined') &&
				d.range.start.line >= 59 &&
				d.range.start.line <= 121
		)
		expect(scriptUndefinedDiags).toEqual([])
	})

	it('does not flag words inside line comments in client scripts', () => {
		const text = `
<script is:build>
	const isHomepage = true
</script>
<script props="{ isHomepage }">
	import { allCaps } from '@scripts/utils/transform'
	// This comment will get stripped from build output
	console.debug(allCaps('[aero]'), isHomepage)
</script>
`
		const doc = {
			uri: { toString: () => 'file:///header.html', fsPath: '/header.html', scheme: 'file' },
			getText: () => text,
			positionAt: (offset: number) => {
				const lines = text.slice(0, offset).split('\n')
				return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 }
			},
			languageId: 'html',
			fileName: '/header.html',
			lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
		} as any

		runDiagnostics(doc)

		const reportedDiagnostics = mockSet.mock.calls[0]?.[1] ?? []
		const commentWordDiag = reportedDiagnostics.find(
			(d: any) =>
				d.message.includes('is not defined') &&
				(d.message.includes("'This'") ||
					d.message.includes("'comment'") ||
					d.message.includes("'stripped'") ||
					d.message.includes("'build'") ||
					d.message.includes("'output'"))
		)
		expect(commentWordDiag).toBeUndefined()
	})
})

describe('AeroDiagnostics Route Contract', () => {
	it('reports unsupported route segments in pages file names as AERO_ROUTE', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vscode-route-'))
		try {
			const pagesDir = path.join(root, 'client', 'pages', 'docs')
			fs.mkdirSync(pagesDir, { recursive: true })
			const filePath = path.join(pagesDir, '[...slug].html')
			const text = '<p>hello</p>\n'
			fs.writeFileSync(filePath, text, 'utf-8')

			const doc = {
				uri: {
					toString: () => `file://${filePath}`,
					fsPath: filePath,
					scheme: 'file',
				},
				getText: () => text,
				positionAt: (offset: number) => ({ line: 0, character: offset }),
				languageId: 'html',
				fileName: filePath,
				lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
			} as any

			const diagnostics = collectDiagnosticsForDocument(doc)
			const routeDiag = diagnostics.find((d: any) =>
				String(d.message).includes('Unsupported route segment')
			)
			expect(routeDiag).toBeDefined()
			if (!routeDiag) throw new Error('Expected route diagnostic')
			const routeCode =
				typeof routeDiag.code === 'object' && routeDiag.code !== null && 'value' in routeDiag.code
					? routeDiag.code.value
					: routeDiag.code
			expect(routeCode).toBe('AERO_ROUTE')
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
})
