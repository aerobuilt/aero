/**
 * Shared type definitions for the Aero framework (compiler, runtime, Vite plugin).
 *
 * @remarks
 * Grouped roughly by: config/dirs, compile/parse, resolver/aliases, routing, render context.
 */

export interface AeroDirs {
	/** Site source directory; pages live at `client/pages` (default: `'client'`). */
	client?: string
	/** Nitro server directory (default: `'server'`). */
	server?: string
	/** Build output directory (default: `'dist'`). */
	dist?: string
}

/** Options for the optional `@aero-js/content` Vite plugin when `content` is enabled. */
export interface AeroContentOptions {
	/** Path to content config file relative to project root (default: `content.config.ts`). */
	config?: string
}

/** One redirect rule: from path to URL, optional status (default 302). */
export interface RedirectRule {
	from: string
	to: string
	status?: number
}

export interface AeroOptions {
	/** Enable content collections (default: `false`). Pass `true` or `AeroContentOptions`. */
	content?: boolean | AeroContentOptions
	/** Enable Nitro server integration (default: `false`). */
	server?: boolean
	/** Enable Aero reactivity pipeline (default: `false`). */
	reactivity?: boolean
	/** Enable Aero hypermedia pipeline (default: `false`). */
	hypermedia?: boolean
	/** API route prefix (default: `'/api'`). */
	apiPrefix?: string
	/** Directory overrides. */
	dirs?: Partial<AeroDirs>
	/**
	 * Canonical site URL (e.g. `'https://example.com'`). Exposed as `import.meta.env.SITE` and
	 * as `Aero.site.url` in templates. Used for sitemap, RSS, and canonical links.
	 */
	site?: { url: string }
	/**
	 * Redirect rules applied in dev (Vite) and when using the Nitro server (preview:api / production).
	 * For static-only deploys use host redirect config (_redirects, vercel.json, etc.).
	 */
	redirects?: RedirectRule[]
	/**
	 * Optional request-time middleware (redirects, rewrites, custom responses).
	 * Runs in dev before rendering; for production redirects use Nitro server middleware or `redirects` config.
	 */
	middleware?: AeroMiddleware[]
	/**
	 * @internal Optional plugins for the static prerender mini-server. Prefer `content` for collections.
	 * Merged after the core Aero plugins so pages that import aero:content resolve during static build.
	 */
	staticServerPlugins?: import('vite').Plugin[]
}

/** Command and mode passed to an env-aware `defineConfig()` callback. */
export interface AeroConfigEnv {
	command: 'dev' | 'build'
	mode: 'development' | 'production'
}

/** Env-aware `aero.config.ts` export: returns options for the given command/mode. */
export type AeroOptionsFn = (env: AeroConfigEnv) => AeroOptions

/** Static options or env-aware function accepted by `defineConfig()`. */
export type AeroOptionsInput = AeroOptions | AeroOptionsFn

/** Request context passed to middleware (url, request, route path, resolved page name, site). */
export interface AeroRequestContext {
	url: URL
	request: Request
	routePath: string
	pageName: string
	site?: string
}

/** Result of middleware: redirect, rewrite render input, or send a custom response. */
export type AeroMiddlewareResult =
	| { redirect: { url: string; status?: number } }
	| { rewrite: Partial<AeroRenderInput> & { pageName?: string } }
	| { response: Response }
	| void

/** Middleware handler: receives request context; returns redirect/rewrite/response or nothing to continue. */
export type AeroMiddleware = (
	ctx: AeroRequestContext
) => AeroMiddlewareResult | Promise<AeroMiddlewareResult>

/** Options for the client-side `mount()` entry (see `core/src/entry-dev.ts`). */
export interface MountOptions {
	/** Root element: CSS selector or `HTMLElement`. Defaults to `#app`. */
	target?: string | HTMLElement
	/** Called with the root element after mount and after each HMR re-render. */
	onRender?: (root: HTMLElement) => void
}

/**
 * Single script entry: attrs (optional), content (body or virtual URL), optional props expression.
 * Used by parser, codegen, Vite plugin, and static build for client/inline/blocking script arrays.
 */
export interface ScriptEntry {
	attrs?: string
	content: string
	passDataExpr?: string
	/** If true, client script is injected in <head> instead of before </body>. */
	injectInHead?: boolean
}

/**
 * Input to the codegen compiler for a single template.
 *
 * @remarks
 * Script arrays come from the parser; `root` and `resolvePath` from the build.
 */
// fallow-ignore-next-line unused-types — public API for `@aero-js/core/types` consumers
export interface CompileOptions {
	root: string
	/** Client script entries (plain `<script>`): after transform, `content` may be virtual URL. */
	clientScripts?: ScriptEntry[]
	/** Inline scripts (`is:inline`) to be emitted in the page. */
	inlineScripts?: ScriptEntry[]
	/** Blocking scripts (`is:blocking`) to be emitted in the page. */
	blockingScripts?: ScriptEntry[]
	/** Resolve import specifiers (e.g. `@components/foo`) from importer file path. */
	resolvePath?: (specifier: string, importer: string) => string
	/** Importer file path (template) for resolution; required when resolvePath is used. */
	importer?: string
	/** Original HTML template source for directive diagnostics (line/column in Vite overlay). */
	diagnosticTemplateSource?: string
}

/** Options for the path resolver (e.g. resolving `@components/foo` to a file path). */
// fallow-ignore-next-line unused-types — public API for `@aero-js/core/types` consumers
export interface ResolverOptions {
	root: string
	resolvePath?: (specifier: string, importer: string) => string
	importer?: string
}

/**
 * Result of parsing one HTML template.
 *
 * @remarks
 * Produced by `parser.ts`. Extracted script blocks and the remaining template string for codegen.
 */
export interface ParseResult {
	/** Single `<script is:build>` block, or `null` if none. */
	buildScript: { content: string } | null
	clientScripts: ScriptEntry[]
	inlineScripts: ScriptEntry[]
	blockingScripts: ScriptEntry[]
	/** HTML after script blocks are stripped; used as input to codegen. */
	template: string
}

/** One path alias from tsconfig (e.g. find: `@components`, replacement: `.../src/components`). */
export interface UserAlias {
	find: string
	replacement: string
}

/** Result of loading project path aliases (`utils/aliases.ts`). */
export interface AliasResult {
	aliases: UserAlias[]
	/** Resolve specifier from importer file path using oxc-resolver. */
	resolve: (specifier: string, importer: string) => string
	/** Project root (directory containing tsconfig.json) when a tsconfig was found. */
	projectRoot?: string
}

/** Head and body HTML fragments (e.g. from `runtime/client` `extractDocumentParts`). */
export interface PageFragments {
	head: string
	body: string
}

/** Dynamic route segment key → value (e.g. `{ id: '42' }` for `/posts/42`). */
export interface AeroRouteParams {
	[key: string]: string
}

/** One static path for pre-rendering (e.g. from static path discovery). */
export interface StaticPathEntry {
	params: AeroRouteParams
	props?: Record<string, any>
}

/**
 * Input passed into a page or layout render (request, url, params, etc.).
 *
 * @remarks
 * Used by the runtime when calling the compiled render function and when rendering child components.
 * Top-level request, url, params are normalized into page; site string is wrapped as site.url.
 */
export interface AeroRenderInput {
	props?: Record<string, any>
	/** Named slot content (key → HTML string) for layout/page render. */
	slots?: Record<string, string>
	request?: Request
	url?: URL | string
	params?: AeroRouteParams
	/** Resolved route path pattern (e.g. `'/posts/[id]'`) for the current request. */
	routePath?: string
	/** Accumulated style URLs/labels for this request. */
	styles?: Set<string>
	/** Accumulated script URLs/labels for this request. */
	scripts?: Set<string>
	/** Scripts to inject in <head>. */
	headScripts?: Set<string>
	/** Canonical site URL from config. String for backward compat; object when passed from Aero.site. */
	site?: string | { url: string }
	/** Page context (url, request, params). When provided, overrides individual request/url/params. */
	page?: { url?: URL; request?: Request; params?: AeroRouteParams; routePath?: string }
}

/**
 * Page context: request URL, Request object, and route params.
 */
// fallow-ignore-next-line unused-types — public API for `@aero-js/core/types` consumers
export interface AeroPageContext {
	url: URL
	request: Request
	params: AeroRouteParams
	/** Canonical matched route path (no trailing slash; root is `'/'`). */
	routePath: string
}

/**
 * Site context: canonical URL and future site-wide properties.
 */
export interface AeroSiteContext {
	url: string
}

/**
 * Context object available inside compiled templates (`is:build`) and when rendering components.
 *
 * @remarks
 * Includes `props`, `slots`, `renderComponent`, `page`, `site`, and optional style/script sets.
 * Use `Aero.page.url`, `Aero.page.request`, `Aero.page.params`, `Aero.page.routePath` for request-scoped data;
 * use `Aero.site.url` for the canonical site URL.
 */
// fallow-ignore-next-line unused-types — public API for `@aero-js/core/types` consumers
export interface AeroTemplateContext {
	[key: string]: any
	props: Record<string, any>
	slots: Record<string, string>
	/** Used by codegen to emit calls that render a child component and return its HTML. */
	renderComponent: (
		component: any,
		props?: Record<string, any>,
		slots?: Record<string, string>,
		context?: AeroRenderInput
	) => Promise<string>
	/** Request-scoped: url, request, params. */
	page: AeroPageContext
	/** Site-scoped: canonical URL and future config. */
	site: AeroSiteContext
	/** Marker/fallback helper for child-mutable reactive props in state scripts. */
	bindable: {
		(): undefined
		<T>(fallback: T): T
	}
	styles?: Set<string>
	scripts?: Set<string>
	headScripts?: Set<string>
}

/** Compiled template render function signature (`export default async function (Aero) { ... }`). */
export type AeroRenderFn = (ctx: AeroTemplateContext) => Promise<string> | string

/**
 * Page/layout module from `import.meta.glob` or a direct import: a render function, a lazy loader,
 * or an object with `default` and optional `getStaticPaths`.
 */
export type AeroPageModule =
	| AeroRenderFn
	| (() => Promise<unknown>)
	| {
			default?: AeroRenderFn
			getStaticPaths?: () => Promise<StaticPathEntry[] | unknown[]>
			mountStateBindings?: (root: HTMLElement, Aero: unknown) => void | (() => void)
	  }

/** Options shared by standalone compiler/runtime helpers. */
export interface StandaloneTemplateCompileOptions {
	/** Project root used to resolve root-relative imports (`/client/...`). */
	root: string
	/** Source file path used as importer for relative import resolution. */
	importer: string
	/** Optional alias/path resolver compatible with compiler `resolvePath`. */
	resolvePath?: (specifier: string, importer: string) => string
}

/** Input for loading precompiled module source into a renderable Aero page module. */
export interface StandaloneLoadCompiledModuleOptions extends StandaloneTemplateCompileOptions {
	/** JavaScript module source generated by `compile()` / `compileTemplate()`. */
	compiledSource: string
}

/** Input for one-shot standalone rendering from HTML template source. */
export interface StandaloneRenderTemplateOptions extends StandaloneTemplateCompileOptions {
	/** HTML template source to compile + execute. */
	templateSource: string
	/** Optional runtime globals injected via `Aero.global(name, value)`. */
	globals?: Record<string, unknown>
	/** Optional render input forwarded to `Aero.render(...)`. */
	input?: AeroRenderInput | Record<string, unknown>
}
