import { PARITY_SCENARIOS } from '../../../../diagnostics/src/__tests__/fixtures/parity/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectTemplateDiagnostics } from '../index'
import type { SourceDocument } from '../source-document'

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..')
const kitchenSinkHypermedia = path.join(
	repoRoot,
	'examples/kitchen-sink/client/pages/demos/hypermedia.html'
)

function makeDocument(text: string, fsPath: string): SourceDocument {
	return {
		uri: { fsPath },
		getText: () => text,
		positionAt: (offset: number) => {
			const lines = text.slice(0, offset).split('\n')
			return {
				line: lines.length - 1,
				character: lines[lines.length - 1]?.length ?? 0,
			}
		},
		offsetAt: (position: { line: number; character: number }) => {
			const lines = text.split('\n')
			let offset = 0
			for (let i = 0; i < position.line; i++) {
				offset += (lines[i]?.length ?? 0) + 1
			}
			return offset + position.character
		},
	}
}

describe('collectTemplateDiagnostics parity', () => {
	for (const scenario of PARITY_SCENARIOS) {
		const expectation = scenario.surfaces.ide ?? scenario.surfaces.vscode ?? scenario.surfaces.cli
		if (!expectation) continue

		it(`${scenario.id}: ${scenario.description}`, () => {
			const diagnostics = collectTemplateDiagnostics({
				document: makeDocument(scenario.html, '/tmp/client/pages/index.html'),
				root: '/tmp',
				flags: scenario.flags,
			})

			const match =
				diagnostics.find(d => d.message.includes(expectation.messageIncludes)) ??
				diagnostics.find(d => d.code === expectation.code)
			expect(match).toBeDefined()
			expect(match!.message).toContain(expectation.messageIncludes)
			expect(match!.code).toBe(expectation.code)
		})
	}
})

describe('collectTemplateDiagnostics feature flags', () => {
	it('loads reactivity and hypermedia flags from nested app root in monorepo workspace', () => {
		const text = fs.readFileSync(kitchenSinkHypermedia, 'utf-8')
		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(text, kitchenSinkHypermedia),
			root: repoRoot,
			workspaceRoot: repoRoot,
		})

		const configErrors = diagnostics.filter(d => d.code === 'AERO_CONFIG')
		expect(configErrors).toEqual([])
	})
})

describe('collectTemplateDiagnostics undefined variables gate', () => {
	it('does not emit Aero Variable diagnostics when build script exists (TS2304 covers them)', () => {
		const html = `<script is:build>
const title = 'Hello'
</script>
<p>{ missingVar }</p>`

		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(html, '/tmp/client/pages/index.html'),
			root: '/tmp',
			flags: { reactivity: false, hypermedia: false },
		})

		expect(diagnostics.some(d => d.message.includes("Variable 'missingVar' is not defined"))).toBe(false)
	})
})

describe('collectTemplateDiagnostics @client import paths', () => {
	const kitchenSinkRoot = path.join(repoRoot, 'examples/kitchen-sink')

	it('does not flag code-component when imported via @client alias', () => {
		const text = `<script is:build>
import code from '@client/components/code.html'
</script>
<code-component code="test" />`
		const pagePath = path.join(kitchenSinkRoot, 'client/pages/demos/templating.html')
		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(text, pagePath),
			root: kitchenSinkRoot,
			workspaceRoot: repoRoot,
		})

		const notImported = diagnostics.filter(d => d.message.includes("Component 'code' is not imported"))
		expect(notImported).toHaveLength(0)
	})

	it('does not flag components imported via custom tsconfig aliases', () => {
		const text = `<script is:build>
import code from '@shared/ui/code.html'
</script>
<code-component code="test" />`
		const pagePath = path.join(kitchenSinkRoot, 'client/pages/demos/templating.html')
		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(text, pagePath),
			root: kitchenSinkRoot,
			workspaceRoot: repoRoot,
		})

		const notImported = diagnostics.filter(d => d.message.includes("Component 'code' is not imported"))
		expect(notImported).toHaveLength(0)
	})
})

describe('collectTemplateDiagnostics component props', () => {
	const kitchenSinkRoot = path.join(repoRoot, 'examples/kitchen-sink')

	it('reports missing required props for individual component attributes', () => {
		const text = `<script is:build>
import card from '@components/card.html'
</script>
<card-component body="Missing title" />`
		const pagePath = path.join(kitchenSinkRoot, 'client/pages/demos/templating.html')
		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(text, pagePath),
			root: kitchenSinkRoot,
			workspaceRoot: repoRoot,
		})

		const missing = diagnostics.find(
			d =>
				d.message.includes("Missing required prop 'title'") &&
				d.message.includes('card-component')
		)
		expect(missing).toBeDefined()
		expect(missing!.code).toBe('AERO_COMPILE')
		const tagStart = text.indexOf('<card-component')
		expect(missing!.span).toEqual({
			file: pagePath,
			line: 3,
			column: 0,
			lineEnd: 3,
			columnEnd: '<card-component'.length,
		})
		expect(tagStart).toBeGreaterThanOrEqual(0)
	})

	it('reports missing required props when component has no attributes', () => {
		const text = `<script is:build>
import card from '@components/card.html'
</script>
<card-component />`
		const pagePath = path.join(kitchenSinkRoot, 'client/pages/demos/props.html')
		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(text, pagePath),
			root: kitchenSinkRoot,
			workspaceRoot: repoRoot,
		})

		const missing = diagnostics.find(
			d =>
				d.message.includes("Missing required prop 'title'") &&
				d.message.includes('card-component')
		)
		expect(missing).toBeDefined()
	})

	it('infers required props from untyped Aero.props destructuring defaults', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-destructure-props-'))
		try {
			const compPath = path.join(dir, 'note.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:build>
const { title, body = 'No body provided.' } = Aero.props
</script>
<p>{ title }: { body }</p>
`,
				'utf-8'
			)
			const text = `<script is:build>
import note from './note.html'
</script>
<note-component body="only body" />`
			fs.writeFileSync(pagePath, text, 'utf-8')
			const diagnostics = collectTemplateDiagnostics({
				document: makeDocument(text, pagePath),
				root: dir,
				workspaceRoot: dir,
			})

			const missing = diagnostics.find(
				d =>
					d.message.includes("Missing required prop 'title'") &&
					d.message.includes('note-component')
			)
			expect(missing).toBeDefined()
			expect(
				diagnostics.some(d => d.message.includes("Missing required prop 'body'"))
			).toBe(false)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('flags bind: when the expression is a build-only variable', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-bind-build-var-'))
		try {
			const compPath = path.join(dir, 'my.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count = Aero.bindable(0) } = Aero.props
</script>
<span>{ count }</span>
`,
				'utf-8'
			)
			const text = `<script is:build>
import my from './my.html'
let count = 0
</script>
<my-component bind:count="{ count }" />`
			fs.writeFileSync(pagePath, text, 'utf-8')
			const diagnostics = collectTemplateDiagnostics({
				document: makeDocument(text, pagePath),
				root: dir,
				workspaceRoot: dir,
			})
			const flagged = diagnostics.find(d =>
				d.message.includes('requires a writable state binding in `<script is:state>`')
			)
			expect(flagged).toBeDefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('flags bind: when the child uses an undestructured Aero.props bag', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-bind-props-bag-'))
		try {
			const compPath = path.join(dir, 'my.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const props = Aero.props
</script>
<span>{ props.count }</span>
`,
				'utf-8'
			)
			const text = `<script is:build>
import my from './my.html'
</script>
<script is:state>
let count = 0
</script>
<my-component bind:count="{ count }" />`
			fs.writeFileSync(pagePath, text, 'utf-8')
			const diagnostics = collectTemplateDiagnostics({
				document: makeDocument(text, pagePath),
				root: dir,
				workspaceRoot: dir,
			})
			const flagged = diagnostics.find(d =>
				d.message.includes('must be declared with `Aero.bindable()`')
			)
			expect(flagged).toBeDefined()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('clears bind: bindable errors when readTextFile overlays an unsaved child fix', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-bind-overlay-'))
		try {
			const compPath = path.join(dir, 'my.html')
			const pagePath = path.join(dir, 'page.html')
			fs.writeFileSync(
				compPath,
				`<script is:state>
const { count } = Aero.props
</script>
<span>{ count }</span>
`,
				'utf-8'
			)
			const text = `<script is:build>
import my from './my.html'
</script>
<script is:state>
let count = 0
</script>
<my-component bind:count="{ count }" />`
			fs.writeFileSync(pagePath, text, 'utf-8')
			const overlays = new Map<string, string>([
				[
					compPath,
					`<script is:state>
const { count = Aero.bindable() } = Aero.props
</script>
<span>{ count }</span>
`,
				],
			])
			try {
				overlays.set(
					fs.realpathSync(compPath),
					overlays.get(compPath)!
				)
			} catch {
				/* ignore */
			}
			const diagnostics = collectTemplateDiagnostics({
				document: makeDocument(text, pagePath),
				root: dir,
				workspaceRoot: dir,
				readTextFile: absolutePath => {
					const hit = overlays.get(absolutePath)
					if (hit !== undefined) return hit
					try {
						return overlays.get(fs.realpathSync(absolutePath))
					} catch {
						return undefined
					}
				},
			})
			expect(
				diagnostics.some(d => d.message.includes('must be declared with `Aero.bindable()`'))
			).toBe(false)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe('collectTemplateDiagnostics unused variables', () => {
	it('does not count a commented props spread as a use', () => {
		const html = `<script is:build>
const props = { title: 'Hello', body: 'World' }
</script>
<!--<card-component props="{ ...props }" />-->`

		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(html, '/tmp/client/pages/commented.html'),
			root: '/tmp',
			flags: { reactivity: false, hypermedia: false },
		})

		expect(
			diagnostics.some(d => d.message.includes("'props' is declared but its value is never read"))
		).toBe(true)
	})

	it('does not flag spread parameter as unused in is:state', () => {
		const html = `<script is:state>
const nextNumber = (values: number[]) => Math.max(0, ...values) + 1
let numbersArray = [1, 2, 3]
</script>
<button on:click="{ numbersArray.push(nextNumber(numbersArray)) }">Add</button>`

		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(html, '/tmp/client/pages/iterables.html'),
			root: '/tmp',
			flags: { reactivity: true, hypermedia: false },
		})

		const unusedValues = diagnostics.find(d =>
			d.message.includes("'values' is declared but its value is never read")
		)
		expect(unusedValues).toBeUndefined()
	})
})

describe('collectTemplateDiagnostics snippet modules', () => {
	it('skips template diagnostics for content/snippets html files', () => {
		const html = `<!-- @snippet:propsString -->
<greeting-component name="Aero" />
`
		const diagnostics = collectTemplateDiagnostics({
			document: makeDocument(html, '/app/content/snippets/markup.html'),
			root: '/app',
		})

		expect(diagnostics).toEqual([])
	})
})
