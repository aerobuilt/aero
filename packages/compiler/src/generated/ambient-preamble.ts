/**
 * Generated from packages/compiler/env.d.ts - do not edit manually.
 * Run: node scripts/generate-ambient-preamble.mjs
 */

export const BUILD_SCRIPT_PREAMBLE = `declare const Aero: {
	
	props: Record<string, any>
	
	slots: Record<string, string>
	
	page: { url: URL; request: Request; params: Record<string, string>; routePath: string }
	
	site: { url: string }
	
	bindable(): undefined
	bindable<T>(fallback: T): T
}

declare function \$effect(fn: () => void | (() => void)): void

declare const \$root: ParentNode

interface Snippet {
	readonly code: string
	readonly lang: string
}

declare namespace Aero {
	interface ComponentRegistry {}
}

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

declare function raw(value: unknown): string
`

export const AMBIENT_DECLARATIONS = `declare module '*.html' {
	const component: string
	export default component
}

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

declare module 'aero:content' {
	interface CollectionEntry {
		id: string
		data: Record<string, any>
		body?: string
	}
	export function getCollection(name: string): Promise<CollectionEntry[]>
	export function render(entry: CollectionEntry | Record<string, any>): Promise<{ html: string }>
}
`
