/**
 * AST-based analysis of Aero build scripts: extract imports and getStaticPaths export.
 *
 * @remarks
 * Uses oxc-parser (TypeScript-capable) so the same pipeline supports JS and TS in
 * `<script is:build>`. Returns structured data for codegen to rewrite imports and
 * emit getStaticPaths as a named export.
 */

import { parseSync, ImportNameKind } from 'oxc-parser'
import { transformSync } from 'oxc-transform'

/** Strip TypeScript syntax from a script string, returning plain JavaScript. */
export function stripBuildScriptTypes(code: string, filename = 'script.ts'): string {
	if (!code.trim()) return code
	const result = transformSync(filename, code, { typescript: { onlyRemoveTypeImports: true } })
	return result.code.replace(/(?:^|\n)\s*export\s\{\s*\}\s*;?/g, '')
}

/** Core binding extraction shared by `analyzeBuildScript` and `analyzeBuildScriptForEditor`. */
function extractBindingsFromStaticImport(
	imp: {
		entries: Iterable<{
			isType: boolean
			localName: { value: string; start: number; end: number }
			importName: { kind: ImportNameKind; name?: string | null }
		}>
	},
	includeRanges: boolean
): Pick<BuildScriptImport, 'defaultBinding' | 'namedBindings' | 'namespaceBinding'> & {
	bindingRanges?: Record<string, [number, number]>
} {
	let defaultBinding: string | null = null
	let namespaceBinding: string | null = null
	const namedBindings: Array<{ imported: string; local: string }> = []
	const bindingRanges: Record<string, [number, number]> | undefined = includeRanges ? {} : undefined

	for (const entry of imp.entries) {
		if (entry.isType) continue

		const local = entry.localName.value
		if (bindingRanges) {
			bindingRanges[local] = [entry.localName.start, entry.localName.end]
		}

		switch (entry.importName.kind) {
			case ImportNameKind.Default:
				defaultBinding = local
				break
			case ImportNameKind.NamespaceObject:
				namespaceBinding = local
				break
			case ImportNameKind.Name: {
				const imported = entry.importName.name ?? local
				namedBindings.push({ imported, local })
				break
			}
			default:
				break
		}
	}

	return {
		defaultBinding,
		namedBindings,
		namespaceBinding,
		...(bindingRanges ? { bindingRanges } : {}),
	}
}

/** Single import entry for codegen: specifier and bindings. */
export interface BuildScriptImport {
	specifier: string
	defaultBinding: string | null
	namedBindings: Array<{ imported: string; local: string }>
	namespaceBinding: string | null
}

/** Result of analyzing a build script: imports, optional getStaticPaths text, and script with both removed. */
export interface BuildScriptAnalysisResult {
	imports: BuildScriptImport[]
	getStaticPathsFn: string | null
	scriptWithoutImportsAndGetStaticPaths: string
}

const BUILD_SCRIPT_FILENAME = 'build.ts'
const BUILD_SCRIPT_PARSE_OPTIONS = {
	sourceType: 'module',
	range: true,
	lang: 'ts',
} as const

type BuildScriptParseResult = ReturnType<typeof parseSync>

function parseBuildScript(script: string): BuildScriptParseResult {
	return parseSync(BUILD_SCRIPT_FILENAME, script, BUILD_SCRIPT_PARSE_OPTIONS)
}

function throwIfBuildScriptParseErrors(result: BuildScriptParseResult): void {
	const errors = result.errors
	if (errors.length === 0) return
	const first = errors[0]
	throw new Error(
		`[aero] Build script parse error: ${first.message}${first.codeframe ? '\n' + first.codeframe : ''}`
	)
}

interface BuildScriptStaticImportLike {
	start: number
	end: number
	moduleRequest: { value: string; start: number; end: number }
	entries: Iterable<{
		isType: boolean
		localName: { value: string; start: number; end: number }
		importName: { kind: ImportNameKind; name?: string | null }
	}>
}

interface BuildScriptImportCollected extends BuildScriptImport {
	range: [number, number]
	specifierRange: [number, number]
	bindingRanges?: Record<string, [number, number]>
}

function collectBuildScriptImports(
	staticImports: Iterable<BuildScriptStaticImportLike>,
	includeRanges: boolean
): BuildScriptImportCollected[] {
	const imports: BuildScriptImportCollected[] = []
	for (const imp of staticImports) {
		const extracted = extractBindingsFromStaticImport(imp, includeRanges)
		const { bindingRanges, ...bindings } = extracted
		imports.push({
			specifier: imp.moduleRequest.value,
			...bindings,
			range: [imp.start, imp.end],
			specifierRange: [imp.moduleRequest.start, imp.moduleRequest.end],
			...(bindingRanges ? { bindingRanges } : {}),
		})
	}
	return imports
}

function findGetStaticPathsRange(program: unknown): [number, number] | null {
	const body = (
		program as {
			body?: Array<{
				type: string
				declaration?: { type: string; id?: { name: string } }
				range?: [number, number]
			}>
		}
	).body
	if (!body) return null
	for (const stmt of body) {
		if (stmt.type !== 'ExportNamedDeclaration') continue
		const decl = stmt.declaration
		if (!decl || decl.type !== 'FunctionDeclaration') continue
		if (decl.id?.name !== 'getStaticPaths') continue
		if (stmt.range) return stmt.range
	}
	return null
}

function removeRangesFromSource(source: string, ranges: Array<[number, number]>): string {
	if (ranges.length === 0) return source.trim()
	const sortedRanges = [...ranges].sort((a, b) => a[0] - b[0])
	const parts: string[] = []
	let lastEnd = 0
	for (const [start, end] of sortedRanges) {
		if (start > lastEnd) {
			parts.push(source.slice(lastEnd, start))
		}
		lastEnd = end
	}
	if (lastEnd < source.length) {
		parts.push(source.slice(lastEnd))
	}
	return parts.join('').trim()
}

/**
 * Analyze build script source: parse with oxc, extract static imports and
 * `export [async] function getStaticPaths(...)`, return bindings and script with those removed.
 *
 * @param script - Raw build script content (JS or TS).
 * @returns Structured result for codegen. On parse error, throws.
 */
export function analyzeBuildScript(script: string): BuildScriptAnalysisResult {
	if (!script.trim()) {
		return {
			imports: [],
			getStaticPathsFn: null,
			scriptWithoutImportsAndGetStaticPaths: script,
		}
	}

	const result = parseBuildScript(script)
	throwIfBuildScriptParseErrors(result)

	const mod = result.module

	// 1. Build imports from ESM module info (skip type-only imports for runtime rewrite)
	const imports = collectBuildScriptImports(mod.staticImports, false).map(
		({ range: _range, specifierRange: _specifierRange, bindingRanges: _bindingRanges, ...imp }) =>
			imp
	)

	// 2. Find export function getStaticPaths in program body (ESTree/TS-ESTree shape)
	const getStaticPathsRange = findGetStaticPathsRange(result.program)

	const getStaticPathsFn =
		getStaticPathsRange !== null
			? script.slice(getStaticPathsRange[0], getStaticPathsRange[1])
			: null

	// 3. Build script without imports and getStaticPaths: merge and sort ranges, then keep segments between them
	const rangesToRemove: Array<[number, number]> = []
	if (getStaticPathsRange) {
		rangesToRemove.push(getStaticPathsRange)
	}
	for (const imp of mod.staticImports) {
		rangesToRemove.push([imp.start, imp.end])
	}
	const scriptWithoutImportsAndGetStaticPaths = removeRangesFromSource(script, rangesToRemove)

	return {
		imports,
		getStaticPathsFn,
		scriptWithoutImportsAndGetStaticPaths,
	}
}

/** Editor-oriented import entry: same bindings as BuildScriptImport plus source range and per-binding ranges. */
export interface BuildScriptImportForEditor extends BuildScriptImport {
	/** Character range of the full import statement [start, end]. */
	range: [number, number]
	/** Character range of the specifier string (path) within the script. */
	specifierRange: [number, number]
	/** Per-binding character ranges: local name -> [start, end]. */
	bindingRanges?: Record<string, [number, number]>
}

/** Result of analyzeBuildScriptForEditor: imports with source ranges for editor use (e.g. definition provider). */
export interface BuildScriptAnalysisForEditorResult {
	imports: BuildScriptImportForEditor[]
}

/** Result of getPropsTypeFromBuildScript: the type name used in `Aero.props as TypeName`. */
export interface PropsTypeResult {
	typeName: string
	isFromDestructuring: boolean
}

/**
 * Extract the props type name from a build script that uses `Aero.props as TypeName`
 * or `const { ... } = Aero.props as TypeName`.
 *
 * @param script - Raw build script content (JS or TS).
 * @returns The type name and whether it was from destructuring, or null if not found.
 */
export function getPropsTypeFromBuildScript(script: string): PropsTypeResult | null {
	if (!script.trim()) return null

	const result = parseBuildScript(script)

	if (result.errors.length > 0) return null

	const body = (result.program as { body?: unknown[] }).body
	if (!body) return null

	for (const stmt of body) {
		const found = findPropsTypeInNode(stmt)
		if (found) return found
	}
	return null
}

type AstNodeLike = Record<string, unknown>
const PROPS_TYPE_CHILD_KEYS = ['init', 'expression', 'argument', 'body', 'consequent', 'alternate']

function asAstNodeLike(value: unknown): AstNodeLike | null {
	return value && typeof value === 'object' ? (value as AstNodeLike) : null
}

function hasNodeType(node: AstNodeLike, type: string): boolean {
	return node.type === type
}

function isTSAsExpressionNode(node: AstNodeLike): boolean {
	return hasNodeType(node, 'TSAsExpression')
}

function isVariableDeclarationNode(node: AstNodeLike): boolean {
	return hasNodeType(node, 'VariableDeclaration')
}

function isObjectPatternNode(node: unknown): boolean {
	const n = asAstNodeLike(node)
	return !!n && hasNodeType(n, 'ObjectPattern')
}

function getIdentifierName(node: unknown): string | null {
	const n = asAstNodeLike(node)
	if (!n) return null
	const name = n.name
	return typeof name === 'string' ? name : null
}

function findPropsTypeInNode(node: unknown): PropsTypeResult | null {
	const n = asAstNodeLike(node)
	if (!n) return null

	if (isTSAsExpressionNode(n)) {
		if (isAeroProps(n.expression)) {
			const typeAnnotation = asAstNodeLike(n.typeAnnotation)
			const typeName = getTypeNameFromAnnotation(typeAnnotation)
			if (typeName) {
				return { typeName, isFromDestructuring: false }
			}
		}
		return null
	}

	if (isVariableDeclarationNode(n)) {
		const declarations = n.declarations as unknown[]
		for (const decl of declarations ?? []) {
			const d = asAstNodeLike(decl)
			if (!d) continue
			const isDestructuring = isObjectPatternNode(d.id)
			const init = d.init
			const found = findPropsTypeInNode(init)
			if (found) {
				return { ...found, isFromDestructuring: isDestructuring }
			}
		}
		return null
	}

	// Recurse into expression/statement children
	for (const key of PROPS_TYPE_CHILD_KEYS) {
		const child = n[key]
		if (Array.isArray(child)) {
			for (const c of child) {
				const found = findPropsTypeInNode(c)
				if (found) return found
			}
		} else if (child) {
			const found = findPropsTypeInNode(child)
			if (found) return found
		}
	}
	return null
}

function isAeroProps(expr: unknown): boolean {
	const n = asAstNodeLike(expr)
	if (!n || !hasNodeType(n, 'MemberExpression')) return false
	const objName = getIdentifierName(n.object)
	const propName = getIdentifierName(n.property)
	return objName === 'Aero' && propName === 'props'
}

function getTypeNameFromAnnotation(annotation: AstNodeLike | null): string | null {
	if (!annotation || !hasNodeType(annotation, 'TSTypeReference')) return null
	return getIdentifierName(annotation.typeName)
}

const TYPE_DECL_IN_EXPORT = new Set([
	'TSInterfaceDeclaration',
	'TSTypeAliasDeclaration',
	'TSEnumDeclaration',
])

function pushRangeSliceIfPresent(
	out: string[],
	source: string,
	range: [number, number] | undefined
): void {
	if (range) out.push(source.slice(range[0], range[1]))
}

/**
 * Extract required prop names from `const { … } = Aero.props` destructuring.
 * Bindings without a default are required; bindings with a default are optional.
 * Does not consult TypeScript interfaces — callers that have `as Type` should prefer the type.
 *
 * @param script - Raw build script content (JS or TS).
 * @returns Required public prop names (object keys), or [] if none / parse error.
 */
export function getRequiredPropsFromAeroPropsDestructure(script: string): string[] {
	if (!script.trim()) return []

	const result = parseBuildScript(script)
	if (result.errors.length > 0) return []

	const body = (result.program as { body?: unknown[] }).body
	if (!body) return []

	const required: string[] = []
	for (const stmt of body) {
		const n = asAstNodeLike(stmt)
		if (!n || !isVariableDeclarationNode(n)) continue
		for (const decl of (n.declarations as unknown[]) ?? []) {
			const d = asAstNodeLike(decl)
			if (!d || !isObjectPatternNode(d.id)) continue
			if (!isAeroPropsInit(d.init)) continue
			const pattern = asAstNodeLike(d.id)
			for (const property of (pattern?.properties as unknown[]) ?? []) {
				const prop = asAstNodeLike(property)
				if (!prop || !hasNodeType(prop, 'Property')) continue
				if (prop.computed === true) continue
				const propName = propertyKeyName(prop.key)
				if (!propName) continue
				const value = asAstNodeLike(prop.value)
				if (!value) continue
				if (hasNodeType(value, 'AssignmentPattern')) continue
				if (hasNodeType(value, 'Identifier')) {
					required.push(propName)
				}
			}
		}
	}
	return required
}

function isAeroPropsInit(init: unknown): boolean {
	return isAeroProps(unwrapTsExpression(init))
}

function unwrapTsExpression(node: unknown): unknown {
	let current = node
	while (true) {
		const n = asAstNodeLike(current)
		if (!n) return current
		if (
			hasNodeType(n, 'TSAsExpression') ||
			hasNodeType(n, 'TSSatisfiesExpression') ||
			hasNodeType(n, 'TSNonNullExpression')
		) {
			current = n.expression
			continue
		}
		return current
	}
}

function propertyKeyName(key: unknown): string | null {
	const n = asAstNodeLike(key)
	if (!n) return null
	if (hasNodeType(n, 'Identifier')) return getIdentifierName(n)
	if (hasNodeType(n, 'Literal') && typeof n.value === 'string') return n.value
	return null
}

/**
 * Extract verbatim source slices for top-level `interface` / `type` / `enum` declarations
 * (including `export …`), for injection into template expression ambient TypeScript.
 *
 * @param script - Raw build script content (JS or TS).
 * @returns Declaration texts in source order. On parse error, returns [].
 */
export function extractBuildScriptTypeDeclarationTexts(script: string): string[] {
	if (!script.trim()) return []

	const result = parseBuildScript(script)
	if (result.errors.length > 0) return []

	const body = (result.program as { body?: unknown[] }).body
	if (!body) return []

	const out: string[] = []
	for (const stmt of body) {
		if (!stmt || typeof stmt !== 'object') continue

		const s = stmt as Record<string, unknown>
		if (s.type === 'ExportNamedDeclaration') {
			const decl = s.declaration as Record<string, unknown> | undefined
			const dt = decl?.type as string | undefined
			if (decl && dt && TYPE_DECL_IN_EXPORT.has(dt)) {
				pushRangeSliceIfPresent(out, script, s.range as [number, number] | undefined)
			}
			continue
		}

		const t = s.type as string
		if (t && TYPE_DECL_IN_EXPORT.has(t)) {
			pushRangeSliceIfPresent(out, script, s.range as [number, number] | undefined)
		}
	}
	return out
}

/**
 * Analyze build script for editor use: same as analyzeBuildScript but returns imports with
 * source ranges (full statement and per-binding) so the extension can map to vscode.Range.
 *
 * @param script - Raw build script content (JS or TS).
 * @returns Imports with range and bindingRanges. On parse error, throws.
 */
export function analyzeBuildScriptForEditor(script: string): BuildScriptAnalysisForEditorResult {
	if (!script.trim()) {
		return { imports: [] }
	}

	const result = parseBuildScript(script)
	throwIfBuildScriptParseErrors(result)

	const mod = result.module
	const imports: BuildScriptImportForEditor[] = collectBuildScriptImports(
		mod.staticImports,
		true
	).map(({ bindingRanges, ...imp }) => ({
		...imp,
		bindingRanges: bindingRanges ?? {},
	}))

	return { imports }
}
