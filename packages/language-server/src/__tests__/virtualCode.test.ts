import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { AeroVirtualCode } from '../virtualCode'
import type { IScriptSnapshot } from '@volar/language-core'

function createSnapshot(text: string): IScriptSnapshot {
	return {
		getText: (start: number, end: number) => text.substring(start, end),
		getLength: () => text.length,
		getChangeRange: () => undefined,
	}
}

function getEmbeddedById(code: AeroVirtualCode, id: string) {
	return code.embeddedCodes?.find(c => c.id === id)
}

function getEmbeddedText(code: AeroVirtualCode, id: string) {
	const embedded = getEmbeddedById(code, id)
	if (!embedded) return undefined
	return embedded.snapshot.getText(0, embedded.snapshot.getLength())
}

function semanticDiagnosticCodes(
	virtualScript: string,
	ambient: string,
	extraRootFiles: string[] = []
): number[] {
	const opts: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noUnusedLocals: true,
		skipLibCheck: true,
		noEmit: true,
	}
	const virtualFile = '/probe/virtual.ts'
	const ambientFile = '/probe/ambient.d.ts'
	const host = ts.createCompilerHost(opts, true)
	const orig = host.getSourceFile.bind(host)
	host.getSourceFile = (fileName, languageVersion, ...rest) => {
		if (fileName === virtualFile) {
			return ts.createSourceFile(
				fileName,
				virtualScript,
				languageVersion,
				true,
				ts.ScriptKind.TS
			)
		}
		if (fileName === ambientFile) {
			return ts.createSourceFile(fileName, ambient, languageVersion, true, ts.ScriptKind.TS)
		}
		return orig(fileName, languageVersion, ...rest)
	}
	const program = ts.createProgram([virtualFile, ambientFile, ...extraRootFiles], opts, host)
	const sf = program.getSourceFile(virtualFile)
	if (!sf) return []
	return program.getSemanticDiagnostics(sf).map(d => d.code)
}

describe('AeroVirtualCode', () => {
	it('does not generate TypeScript expressions from HTML comments', () => {
		const html = `<script is:build>const props = { title: 'x', body: 'y' }</script>
<!--<card-component props="{ ...props }" />-->`
		const code = new AeroVirtualCode(createSnapshot(html))
		expect(code.embeddedCodes.some(embedded => embedded.id.startsWith('expr_'))).toBe(false)
	})

	it('does not produce cross-file TS2451 when build script declares props and interpolations use props (starter-minimal header pattern)', () => {
		const html = `<script is:build>
	const props = Aero.props
</script>

<header>
	<h1>{ props.title || 'Fallback Title' }</h1>
	<p class="subtitle">{ props.subtitle }</p>
</header>
`
		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedText(code, 'build_0')!
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(build).toContain('export {}')
		expect(expr0).toContain('export {}')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const fBuild = ts.createSourceFile('x.build.ts', build, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const fExpr = ts.createSourceFile('x.expr.ts', expr0, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const orig = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('x.build.ts')) return fBuild
			if (fileName.endsWith('x.expr.ts')) return fExpr
			return orig(fileName, languageVersion, ...rest)
		}
		const prog = ts.createProgram(['x.build.ts', 'x.expr.ts'], opts, host)
		const diags = [...prog.getSemanticDiagnostics(fBuild), ...prog.getSemanticDiagnostics(fExpr)]
		const codes = diags.map(d => d.code)
		expect(codes).not.toContain(2451)
	})

	it('extracts build script as typescript virtual code when lang="ts"', () => {
		const html = `<script is:build lang="ts">
const { title } = Aero.props
</script>
<h1>{ title }</h1>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedById(code, 'build_0')

		expect(build).toBeDefined()
		expect(build!.languageId).toBe('typescript')

		const text = getEmbeddedText(code, 'build_0')!
		expect(text).toContain('declare const Aero')
		expect(text).toContain('const { title } = Aero.props')
	})

	it('injects interface declarations from build script before declare const in expression virtual TS', () => {
		const html = `<script is:build lang="ts">
interface PageProps { title: string }
const { title } = Aero.props as PageProps
</script>
<div>{ title }</div>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('interface PageProps')
		expect(expr0.indexOf('interface PageProps')).toBeLessThan(expr0.indexOf('declare const title'))
		expect(expr0).toMatch(/declare const title: string;/)
	})

	it('injects build-scope declare const bindings before template { } expression TS', () => {
		const html = `<script is:build>
const isHomepage = Aero.page.url.pathname === '/'
const props = Aero.props as { x: number }
</script>
<div>{ isHomepage } { props.x }</div>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toMatch(/declare const isHomepage: boolean;/)
		expect(expr0).toContain('declare const props:')
		const expr0Body = ' isHomepage '
		expect(expr0.indexOf('declare const isHomepage')).toBeLessThan(expr0.indexOf(expr0Body))

		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toMatch(/declare const props: \{[^}]*x: number/)
		expect(expr1).toContain(' props.x ')
		expect(expr1.indexOf('declare const props')).toBeLessThan(expr1.indexOf(' props.x '))
	})

	it('includes ambient preamble before build script content', () => {
		const html = `<script is:build lang="ts">
const x = 1
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'build_0')!

		expect(text).toContain('declare const Aero:')
		expect(text).toContain('declare function renderComponent(')
		expect(text).not.toContain("declare module '*.html'")
		const ambient = getEmbeddedText(code, 'ambient')!
		expect(ambient).not.toContain("declare module '*.html'")
		expect(ambient).toContain("declare module '*.jpg'")
		expect(ambient).toContain("declare module 'aero:content'")
		expect(ambient).not.toContain("declare module '*.ts'")
		const preambleEnd = text.indexOf('const x = 1')
		expect(preambleEnd).toBeGreaterThan(0)
	})

	it('injects build-scope bindings into is:state virtual TS', () => {
		const html = `<script is:build>
const initialItems = [{ id: 'a' }, { id: 'b' }]
</script>
<script is:state>
let items = initialItems
</script>
<ul><li for="{ const item of items }">{ item.id }</li></ul>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'state_0')!
		expect(text).toContain('declare const initialItems:')
		expect(text).toContain('items')
		expect(text).toContain('initialItems')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('state.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('state.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['state.ts'], opts, host)
		const codes = program.getSemanticDiagnostics(source).map(d => d.code)
		expect(codes).not.toContain(2304)
	})

	it('widens writable is:state let bindings in state virtual TS', () => {
		const html = `<script is:state>
const AuthState = { SignedIn: 'SignedIn', SignedOut: 'SignedOut' } as const
type AuthState = (typeof AuthState)[keyof typeof AuthState]
let authState = AuthState.SignedOut
function toggleAuth() {
	authState = authState === AuthState.SignedIn ? AuthState.SignedOut : AuthState.SignedIn
}
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'state_0')!
		expect(text).toContain('let authState: AuthState = AuthState.SignedOut as AuthState')
	})

	it('includes Aero.bindable in state virtual TS preamble', () => {
		const html = `<script is:state>
const { count = Aero.bindable(), value = Aero.bindable(0) } = Aero.props
function inc() { value++ }
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'state_0')!
		expect(text).toContain('bindable(): undefined')
		expect(text).toContain('bindable<T>(fallback: T): T')
		expect(text).toContain('let { count = Aero.bindable(), value = Aero.bindable(0) } = Aero.props')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('state.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('state.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['state.ts'], opts, host)
		const codes = program.getSemanticDiagnostics(source).map(d => d.code)
		expect(codes).not.toContain(2339)
		expect(codes).not.toContain(2588)
	})

	it('includes $effect in state virtual TS preamble', () => {
		const html = `<script is:state>
let count = 0
$effect(() => { count })
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'state_0')!
		expect(text).toContain('declare function $effect(fn: () => void | (() => void)): void')
		expect(text).toContain('$effect(() => { count })')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('state.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('state.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['state.ts'], opts, host)
		const codes = program.getSemanticDiagnostics(source).map(d => d.code)
		expect(codes).not.toContain(2304)
	})

	it('does not emit TS2588 for readonly reactive prop writes in event handler virtual TS', () => {
		const html = `<script is:state>
const { count } = Aero.props
</script>
<button on:click="{ count++ }">+</button>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'expr_0')!
		expect(text).toContain('declare let count')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('expr.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('expr.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['expr.ts'], opts, host)
		const codes = program.getSemanticDiagnostics(source).map(d => d.code)
		expect(codes).not.toContain(2588)
	})

	it('does not emit TS2304 for hypermedia GET/POST in event handler virtual TS', () => {
		const html = `<script is:state>
let status = 'Ready'
</script>
<button on:click="{ GET('/api/hypermedia-demo', { target: '#hypermedia-result' }) }">Load</button>
<button on:click="{ POST('/api/save', { state: 'status' }) }">Save</button>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('declare function GET')
		expect(expr0).toContain('declare const event')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('expr.ts', expr0, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('expr.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['expr.ts'], opts, host)
		const codes = program.getSemanticDiagnostics(source).map(d => d.code)
		expect(codes).not.toContain(2304)
	})

	it('emits TS2304 for unimported GET in is:state virtual TS', () => {
		const html = `<script is:state>
const load = () => GET('/api/x')
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'state_0')!
		expect(text).not.toContain('declare function GET')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('state.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		const host = ts.createCompilerHost(opts)
		const originalGetSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			if (fileName.endsWith('state.ts')) return source
			return originalGetSourceFile(fileName, languageVersion, ...rest)
		}
		const program = ts.createProgram(['state.ts'], opts, host)
		expect(program.getSemanticDiagnostics(source).map(d => d.code)).toContain(2304)
	})

	it('does not emit TS2322 for hypermedia state option with owned binding', () => {
		const html = `<script is:state>let isSaving = false</script>
<button on:click="{ POST('/api/save', { target: '#save-status', state: isSaving }) }">Save</button>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('state: __aeroSignal("isSaving")')

		const opts: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		}
		const source = ts.createSourceFile('expr.ts', expr0, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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

	it('maps build script offsets correctly', () => {
		const scriptContent = '\nconst { title } = Aero.props\n'
		const html = `<script is:build lang="ts">${scriptContent}</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedById(code, 'build_0')!

		const mapping = build.mappings[0]
		expect(mapping.sourceOffsets[0]).toBe('<script is:build lang="ts">'.length)
		expect(mapping.lengths[0]).toBe(scriptContent.length)

		const virtualText = build.snapshot.getText(0, build.snapshot.getLength())
		const mappedContent = virtualText.substring(
			mapping.generatedOffsets[0],
			mapping.generatedOffsets[0] + mapping.lengths[0]
		)
		expect(mappedContent).toBe(scriptContent)
	})

	it('extracts client script as typescript virtual code when lang="ts"', () => {
		const html = `<script lang="ts">
document.querySelector('.btn')
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const client = getEmbeddedById(code, 'client_0')

		expect(client).toBeDefined()
		expect(client!.languageId).toBe('typescript')

		const text = getEmbeddedText(code, 'client_0')!
		expect(text).toContain("document.querySelector('.btn')")
		expect(text).not.toContain('declare const Aero')
	})

	it('extracts blocking script as typescript virtual code when lang="ts"', () => {
		const html = `<script is:blocking lang="ts">
const theme = localStorage.getItem('theme')
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const blocking = getEmbeddedById(code, 'blocking_0')

		expect(blocking).toBeDefined()
		expect(blocking!.languageId).toBe('typescript')
	})

	it('extracts inline scripts as javascript when no lang', () => {
		const html = `<script is:inline>
alert('hello')
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const inline = getEmbeddedById(code, 'inline_0')
		expect(inline).toBeDefined()
		expect(inline!.languageId).toBe('javascript')
		expect(getEmbeddedText(code, 'inline_0')).toContain("alert('hello')")
	})

	it('extracts props scripts as embedded JS/TS like inline', () => {
		const html = `<script props="{ storageKey }">
const theme = JSON.parse(localStorage.getItem(storageKey))
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const inline = getEmbeddedById(code, 'inline_0')
		expect(inline).toBeDefined()
		expect(inline!.languageId).toBe('javascript')
	})

	it('injects declare const preamble for props-injected script globals', () => {
		const html = `<script is:build>
const { storageKey, attribute } = site.theme
</script>
<script props="{ storageKey, attribute }">
const theme = JSON.parse(localStorage.getItem(storageKey))
document.documentElement.setAttribute(attribute, theme)
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const text = getEmbeddedText(code, 'inline_0')!
		expect(text).toContain('declare const storageKey: any;')
		expect(text).toContain('declare const attribute: any;')
		expect(text).toContain('localStorage.getItem(storageKey)')
	})

	it('extracts inline script as typescript when lang="ts"', () => {
		const html = `<script is:inline lang="ts">
const x: number = 1
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const inline = getEmbeddedById(code, 'inline_0')
		expect(inline).toBeDefined()
		expect(inline!.languageId).toBe('typescript')
	})

	it('ignores external scripts', () => {
		const html = `<script src="https://cdn.example.com/lib.js"></script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		expect(code.embeddedCodes?.filter(c => c.id !== 'ambient').length).toBe(0)
	})

	it('ignores importmap scripts', () => {
		const html = `<script type="importmap">
{"imports":{"htmx.org":"https://unpkg.com/htmx.org@2.0.8/dist/htmx.esm.js"}}
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		expect(code.embeddedCodes?.filter(c => c.id !== 'ambient').length).toBe(0)
	})

	it('extracts style blocks as CSS virtual code', () => {
		const html = `<style>
body { margin: 0; }
</style>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const style = getEmbeddedById(code, 'style_0')

		expect(style).toBeDefined()
		expect(style!.languageId).toBe('css')

		const text = getEmbeddedText(code, 'style_0')!
		expect(text).toContain('body { margin: 0; }')
	})

	it('extracts multiple script blocks with unique IDs', () => {
		const html = `<script is:build lang="ts">
const { title } = Aero.props
</script>
<script lang="ts">
console.log('client 1')
</script>
<script lang="ts">
console.log('client 2')
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		expect(getEmbeddedById(code, 'build_0')).toBeDefined()
		expect(getEmbeddedById(code, 'client_0')).toBeDefined()
		expect(getEmbeddedById(code, 'client_1')).toBeDefined()
	})

	it('skips empty script blocks', () => {
		const html = `<script is:build lang="ts"></script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		expect(code.embeddedCodes?.filter(c => c.id !== 'ambient').length).toBe(0)
	})

	it('extracts build script without lang as typescript (default)', () => {
		const html = `<script is:build>
const x = 1
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedById(code, 'build_0')
		expect(build).toBeDefined()
		expect(build!.languageId).toBe('typescript')
		const text = getEmbeddedText(code, 'build_0')!
		expect(text).toContain('const x = 1')
		expect(text).toContain('declare const Aero')
	})

	it('extracts build script with lang="js" as javascript', () => {
		const html = `<script is:build lang="js">
const x = 1
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedById(code, 'build_0')
		expect(build).toBeDefined()
		expect(build!.languageId).toBe('javascript')
		expect(getEmbeddedText(code, 'build_0')).not.toContain('declare const Aero')
	})

	it('extracts build script with lang="javascript" as javascript', () => {
		const html = `<script is:build lang="javascript">
const x = 1
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedById(code, 'build_0')
		expect(build).toBeDefined()
		expect(build!.languageId).toBe('javascript')
		expect(getEmbeddedText(code, 'build_0')).not.toContain('declare const Aero')
	})

	it('extracts client script without lang="ts" as javascript', () => {
		const html = `<script>
console.log('client')
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const client = getEmbeddedById(code, 'client_0')
		expect(client).toBeDefined()
		expect(client!.languageId).toBe('javascript')
		expect(getEmbeddedText(code, 'client_0')).toContain("console.log('client')")
	})

	it('accepts lang="typescript"', () => {
		const html = `<script is:build lang="typescript">
const x = 1
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const build = getEmbeddedById(code, 'build_0')
		expect(build).toBeDefined()
		expect(build!.languageId).toBe('typescript')
		expect(getEmbeddedText(code, 'build_0')).toContain('const x = 1')
	})

	it('root virtual code has HTML language ID', () => {
		const html = `<div>hello</div>`
		const code = new AeroVirtualCode(createSnapshot(html))

		expect(code.id).toBe('root')
		expect(code.languageId).toBe('html')
	})

	it('root mappings cover entire document', () => {
		const html = `<h1>hello</h1>`
		const code = new AeroVirtualCode(createSnapshot(html))

		expect(code.mappings).toHaveLength(1)
		expect(code.mappings[0].sourceOffsets[0]).toBe(0)
		expect(code.mappings[0].lengths[0]).toBe(html.length)
	})

	it('extracts template { } interpolations as typescript virtual fragments', () => {
		const html = `<h1>{ title }</h1>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr = getEmbeddedById(code, 'expr_0')
		expect(expr).toBeDefined()
		expect(expr!.languageId).toBe('typescript')
		const text = getEmbeddedText(code, 'expr_0')!
		expect(text).toContain('declare const Aero')
		expect(text).toContain('title')
	})

	it('does not type-check snippet module interpolations as template expressions', () => {
		const html = `<!-- @snippet:expressionProp -->
<greeting-component name="{ expressionTitle }" />`

		const code = new AeroVirtualCode(createSnapshot(html), '/app/content/snippets/markup.html')

		expect(getEmbeddedById(code, 'expr_0')).toBeUndefined()
		expect(code.embeddedCodes?.filter(c => c.id !== 'ambient')).toHaveLength(0)
	})

	it('does not treat braces inside script bodies as template interpolations', () => {
		const html = `<script is:build>
const o = { a: 1 }
</script>`

		const code = new AeroVirtualCode(createSnapshot(html))
		expect(getEmbeddedById(code, 'expr_0')).toBeUndefined()
	})

	it('injects for-directive loop variable into interpolation virtual fragments', () => {
		const html = `<ul><li for="{ const doc of docs }"><span>{ doc.id }</span><span>{ doc.data.title }</span></li></ul>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toContain('declare const doc: any;')
		expect(expr1).toContain(' doc.id ')

		const expr2 = getEmbeddedText(code, 'expr_2')!
		expect(expr2).toContain('declare const doc: any;')
		expect(expr2).toContain(' doc.data.title ')
	})

	it('injects destructured for-directive bindings into interpolation virtual fragments', () => {
		const html = `<li for="{ const { path, label } of links }"><span>{ path }</span><span>{ label }</span></li>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toContain('declare const path: any;')
		expect(expr1).toContain(' path ')

		const expr2 = getEmbeddedText(code, 'expr_2')!
		expect(expr2).toContain('declare const label: any;')
		expect(expr2).toContain(' label ')
	})

	it('injects implicit for-loop variables (index, first, last, length)', () => {
		const html = `<li for="{ const item of items }">{ index } { first } { last } { length }</li>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toContain('declare const index: any;')
		expect(expr1).toContain('declare const first: any;')
		expect(expr1).toContain('declare const last: any;')
		expect(expr1).toContain('declare const length: any;')
		expect(expr1).toContain('declare const item: any;')
	})

	it('handles nested for-directives with both scopes available', () => {
		const html = `<ul for="{ const group of groups }"><li for="{ const item of group.items }">{ group.name } { item.label }</li></ul>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr2 = getEmbeddedText(code, 'expr_2')!
		expect(expr2).toContain('declare const group: any;')
		expect(expr2).toContain('declare const item: any;')
		expect(expr2).toContain(' group.name ')

		const expr3 = getEmbeddedText(code, 'expr_3')!
		expect(expr3).toContain('declare const group: any;')
		expect(expr3).toContain('declare const item: any;')
		expect(expr3).toContain(' item.label ')
	})

	it('creates interpolation virtual fragment for the for-directive head and body expressions', () => {
		const html = `<li for="{ const item of items }">{ item.name }</li>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const allExprs = code.embeddedCodes?.filter(c => c.id.startsWith('expr_')) ?? []
		expect(allExprs).toHaveLength(2)
		const forHead = getEmbeddedText(code, 'expr_0')!
		expect(forHead).toContain('for (const item of items)')
		expect(forHead).toMatch(/void item;/)
		const bodyExpr = getEmbeddedText(code, 'expr_1')!
		expect(bodyExpr).toContain(' item.name ')
	})

	it('extracts interpolations from attribute values', () => {
		const html = `<a href="/docs/{ slug }">link</a>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain(' slug ')
	})

	it('extracts multiple interpolations from a single attribute value', () => {
		const html = `<a href="{ base }/{ path }">link</a>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain(' base ')
		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toContain(' path ')
	})

	it('extracts mixed attribute and text-content interpolations', () => {
		const html = `<a href="/docs/{ slug }">{ title }</a>`

		const code = new AeroVirtualCode(createSnapshot(html))
		// expr_0 is from the attribute (pass 1), expr_1 from text content (pass 2)
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain(' slug ')
		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toContain(' title ')
	})

	it('injects for-directive bindings into attribute interpolation fragments', () => {
		const html = `<li for="{ const doc of docs }"><a href="{ doc.path }">{ doc.title }</a></li>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('declare const doc: any;')
		expect(expr0).toContain(' doc.path ')
		const expr2 = getEmbeddedText(code, 'expr_2')!
		expect(expr2).toContain('declare const doc: any;')
		expect(expr2).toContain(' doc.title ')
	})

	it('injects for-directive bindings into same-tag attribute interpolations', () => {
		const html = `<a for="{ const { path, label } of links }" href="{ path }"> { label } </a>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('declare const path: any;')
		expect(expr0).toContain(' path ')
		const expr2 = getEmbeddedText(code, 'expr_2')!
		expect(expr2).toContain('declare const label: any;')
		expect(expr2).toContain(' label ')
	})

	it('injects build-scope bindings into attribute interpolation fragments', () => {
		const html = `<script is:build>const base = '/docs'</script><a href="{ base }/page">link</a>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toMatch(/declare const base: "\/docs";/)
		expect(expr0).toContain(' base ')
	})

	it('does not extract interpolations from Alpine directive attributes', () => {
		const html = `<div x-bind:class="{ foo }">{ bar }</div>`

		const code = new AeroVirtualCode(createSnapshot(html))
		// Only one expression: the text content { bar }
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain(' bar ')
		expect(getEmbeddedById(code, 'expr_1')).toBeUndefined()
	})

	it('extracts Aero show and class:* binding expressions for virtual TS', () => {
		const html = `<script is:state>
	let body = 'x'
</script>
<div show="{ isOpen }" class:is-active="{ isActive }" html="{ body }"></div>`

		const code = new AeroVirtualCode(createSnapshot(html))
		for (const name of ['isOpen', 'isActive', 'body']) {
			const fragment = code.embeddedCodes?.find(ec => getEmbeddedText(code, ec.id)?.includes(name))
			expect(fragment, name).toBeDefined()
		}
	})

	it('emits TS2304 for missing names in show and class:* virtual fragments', () => {
		const html = `<script is:state>let saving = false</script>
<div show="{ isOpen }" class:is-active="{ isActive }"></div>`
		const code = new AeroVirtualCode(createSnapshot(html))
		const openFragment = code.embeddedCodes?.find(ec =>
			getEmbeddedText(code, ec.id)?.includes('isOpen')
		)
		const activeFragment = code.embeddedCodes?.find(ec =>
			getEmbeddedText(code, ec.id)?.includes('isActive')
		)
		expect(openFragment).toBeDefined()
		expect(activeFragment).toBeDefined()

		for (const fragment of [openFragment!, activeFragment!]) {
			const virtualText = getEmbeddedText(code, fragment.id)!
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

	it('does not treat component markup inside template literal snippets as attribute sites', () => {
		const html = `<script is:state>
	const { count = Aero.bindable() } = Aero.props
</script>
<code>{ \`<header-component bind:count="{ \${count} }" />\` }</code>`
		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('${count}')
		expect(expr0).toContain('`<header-component bind:count="{ ${count} }" />`')
		expect(expr0).not.toContain('[bind:count')
		expect(getEmbeddedById(code, 'expr_1')).toBeUndefined()
	})

	it('treats {{ }} as nested JS interpolation in attribute values', () => {
		const html = `<div data-value="{{ notInterpolated }}">{ real }</div>`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('{ notInterpolated }')
		const expr1 = getEmbeddedText(code, 'expr_1')!
		expect(expr1).toContain(' real ')
	})

	it('wraps props attribute spreads in object-then-array context for valid object spread', () => {
		const html = `<meta-component props="{ ...Aero.props }" />`

		const code = new AeroVirtualCode(createSnapshot(html))
		const expr0 = getEmbeddedText(code, 'expr_0')!
		// Inner `{ ...Aero.props }` becomes `[{ ...Aero.props }]` (not `[...Aero.props]`, which needs an iterable)
		expect(expr0).toContain('[{')
		expect(expr0).toContain('...Aero.props')
		expect(expr0).toContain('}]')
	})

	it('injects slot binding names for parent slot markup from child SlotProps convention', () => {
		const fixtureDir = '/Users/jamie/dev/aero/packages/language-server/src/__tests__/fixtures/slots'
		const parentPath = fixtureDir + '/parent.html'
		const html = `<script is:build>
import card from './card.html'
</script>
<card-component>
  <div slot="item">{ item.price }</div>
</card-component>`

		const code = new AeroVirtualCode(createSnapshot(html), parentPath)
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('interface ItemSlotProps')
		expect(expr0).toContain('declare const item: ItemSlotProps["item"];')
		expect(expr0).toContain('declare const slotProps: ItemSlotProps;')
		expect(expr0).not.toContain('declare const item: any;')
		expect(expr0).toContain(' item.price ')
	})

	it('resolves slot typing from alias import paths', () => {
		const fixtureDir = '/Users/jamie/dev/aero/packages/language-server/src/__tests__/fixtures/slots'
		const parentPath = fixtureDir + '/parent-alias.html'
		const html = `<script is:build>
import card from '@components/card.html'
</script>
<card-component>
  <div slot="item">{ item.name }</div>
</card-component>`

		const code = new AeroVirtualCode(createSnapshot(html), parentPath)
		const expr0 = getEmbeddedText(code, 'expr_0')!
		expect(expr0).toContain('interface ItemSlotProps')
		expect(expr0).toContain('declare const item: ItemSlotProps["item"];')
		expect(expr0).toContain(' item.name ')
	})

	describe('template synthetic uses (TS6133)', () => {
		it('marks component imports used by tags as read in build virtual TS', () => {
			const html = `<script is:build>
import toggle from '@components/theme/toggle.html'
</script>
<toggle-component />`

			const code = new AeroVirtualCode(createSnapshot(html))
			const build = getEmbeddedText(code, 'build_0')!
			const ambient = getEmbeddedText(code, 'ambient')!
			expect(build).toContain('void toggle')
			expect(semanticDiagnosticCodes(build, ambient)).not.toContain(6133)
		})

		it('marks layout imports used by tags as read in build virtual TS', () => {
			const html = `<script is:build>
import base from '@layouts/base.html'
</script>
<base-layout title="Page" />`

			const code = new AeroVirtualCode(createSnapshot(html))
			const build = getEmbeddedText(code, 'build_0')!
			const ambient = getEmbeddedText(code, 'ambient')!
			expect(build).toContain('void base')
			expect(semanticDiagnosticCodes(build, ambient)).not.toContain(6133)
		})

		it('marks bare props shorthand as read in build virtual TS', () => {
			const html = `<script is:build>
const props = { title: 'x', body: 'y' }
</script>
<card-component props />`

			const code = new AeroVirtualCode(createSnapshot(html))
			const build = getEmbeddedText(code, 'build_0')!
			const ambient = getEmbeddedText(code, 'ambient')!
			expect(build).toContain('void props')
			expect(semanticDiagnosticCodes(build, ambient)).not.toContain(6133)
		})

		it('marks is:state bindings used in template as read in state virtual TS', () => {
			const html = `<script is:state>
let count = 1234
</script>
<p>{ count }</p>`

			const code = new AeroVirtualCode(createSnapshot(html))
			const state = getEmbeddedText(code, 'state_0')!
			const ambient = getEmbeddedText(code, 'ambient')!
			expect(state).toContain('void count')
			expect(semanticDiagnosticCodes(state, ambient)).not.toContain(6133)
		})

		it('marks for-directive loop bindings as read in for-head virtual TS', () => {
			const html = `<li for="{ const link of links }">{ link.label }</li>`

			const code = new AeroVirtualCode(createSnapshot(html))
			const forHead = getEmbeddedText(code, 'expr_0')!
			const ambient = getEmbeddedText(code, 'ambient')!
			expect(forHead).toContain('for (const link of links)')
			expect(forHead).toContain('void link')
			expect(semanticDiagnosticCodes(forHead, ambient)).not.toContain(6133)
		})

		it('declares aero:content in shared ambient without *.html wildcard', () => {
			const html = `<script is:build>
import { getCollection } from 'aero:content'
</script>`

			const code = new AeroVirtualCode(createSnapshot(html))
			const ambient = getEmbeddedText(code, 'ambient')!
			expect(ambient).toContain("declare module 'aero:content'")
			expect(ambient).not.toContain("declare module '*.html'")
			expect(semanticDiagnosticCodes(getEmbeddedText(code, 'build_0')!, ambient)).not.toContain(2307)
		})
	})

})
