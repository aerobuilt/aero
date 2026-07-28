/**
 * Ambient type declarations for Aero templates.
 *
 * Include in your project by adding `"types": ["@aero-js/core/env"]` to tsconfig.json,
 * or via a triple-slash directive: `/// <reference types="@aero-js/core/env" />`
 *
 * These declarations type the globals available inside Aero template scripts.
 * Apps should prefer `@aero-js/core/env` (re-export); this file is the canonical source.
 *
 * Single source of truth for virtual TypeScript checking: the compiler generates ambient
 * preamble from this file. When changing globals (Aero, renderComponent, *.html, aero:content), run:
 *   pnpm --dir packages/compiler exec npm run prebuild
 */

/**
 * The `Aero` context object available in build scripts. Provides access to
 * component props, request data, and rendering utilities.
 *
 * Use `Aero.props` (capital A). The lowercase `aero` is not defined at runtime.
 */
declare const Aero: {
	/** Props passed to the current component or page. */
	props: Record<string, any>
	/** Named slot content (key to HTML string). */
	slots: Record<string, string>
	/** Request-scoped: url, request, params, routePath. Use `Aero.page.url`, `Aero.page.request`, `Aero.page.params`, `Aero.page.routePath`. */
	page: { url: URL; request: Request; params: Record<string, string>; routePath: string }
	/** Site-scoped: canonical URL from config. Use `Aero.site.url`. Always defined (empty string when not configured). */
	site: { url: string }
	/** Declare a reactive prop as child-mutable inside `<script is:state>` `Aero.props` destructure defaults. */
	bindable(): undefined
	bindable<T>(fallback: T): T
}

/**
 * Register a reactive side effect in `<script is:state>`.
 * Re-runs when tracked signal reads inside `fn` change. Return a cleanup function to run before re-run and on teardown.
 */
declare function $effect(fn: () => void | (() => void)): void

/**
 * Mount root for the current page or component instance.
 * Use to scope DOM queries in `$effect` (e.g. `$root.querySelector('my-el')`).
 */
declare const $root: ParentNode

/**
 * Named region of source text exported from `@content/snippets/*` modules.
 * Per-module export names are generated under `.aero/cache/types/snippets.d.ts`.
 */
interface Snippet {
	readonly code: string
	readonly lang: string
}

/**
 * Augment with tag names mapped to `{ props: YourProps }` for typed `renderComponent` (see Phase C / component registry).
 * Generated files may place declarations under `.aero/cache/types/`.
 */
declare namespace Aero {
	interface ComponentRegistry {}
}

/**
 * Render a child component and return its HTML.
 *
 * @param component - The imported component (default import from an `.html` file), or a registry key when augmented.
 * @param props - Props to pass to the component.
 * @param slots - Named slot content.
 * @returns The rendered HTML string.
 */
declare function renderComponent<K extends keyof Aero.ComponentRegistry>(
	component: K,
	props?: Aero.ComponentRegistry[K] extends { props: infer P } ? P : Record<string, unknown>,
	slots?: Record<string, string>
): Promise<string>
declare function renderComponent(
	component: any,
	props?: Record<string, any>,
	slots?: Record<string, string>
): Promise<string>

/**
 * Bypass auto-escaping for raw HTML output.
 *
 * @param value - The value to output without HTML escaping.
 * @returns The string representation of `value`, unescaped.
 */
declare function raw(value: unknown): string

/** Allows importing `.html` component files in build scripts. */
declare module '*.html' {
	const component: string
	export default component
}

/**
 * Content document from single-file .md imports (e.g. `import doc from '@content/docs/overview.md'`).
 * Files must be under the project's `content/` directory.
 */
declare module '*.md' {
	interface ContentMeta {
		path: string
		slug: string
		filename: string
		extension: string
	}
	interface ContentDocument {
		id: string
		data: Record<string, any>
		body: string
		_meta: ContentMeta
	}
	const doc: ContentDocument
	export default doc
}

/** Image asset imports (e.g. `import hero from '@images/hero.jpg'`). Resolved to a URL string at build time. */
declare module '*.avif' {
	const src: string
	export default src
}
declare module '*.gif' {
	const src: string
	export default src
}
declare module '*.ico' {
	const src: string
	export default src
}
declare module '*.jpeg' {
	const src: string
	export default src
}
declare module '*.jpg' {
	const src: string
	export default src
}
declare module '*.png' {
	const src: string
	export default src
}
declare module '*.svg' {
	const src: string
	export default src
}
declare module '*.webp' {
	const src: string
	export default src
}

/** Content collections: getCollection, render. Used by the language server for IntelliSense. */
declare module 'aero:content' {
	interface CollectionEntry {
		id: string
		data: Record<string, any>
		body?: string
	}
	export function getCollection(name: string): Promise<CollectionEntry[]>
	export function render(entry: CollectionEntry | Record<string, any>): Promise<{ html: string }>
}
