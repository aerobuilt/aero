/**
 * Resolve import specifiers and paths using tsconfig paths + framework defaults.
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import {
	loadTsconfigAliases,
	mergeWithDefaultAliases,
} from '../utils/aliases'
import { AERO_CONFIG_NAMES } from '../utils/aero-config'
import { loadResolvedAeroConfig } from '../config/loadResolvedAeroConfig'
import { isExistingFile, resolveImportToFile } from './importResolution'

function findAeroAppRoot(startDir: string, workspaceRoot?: string): string | undefined {
	let current = startDir
	const fsRoot = path.parse(current).root
	const stopAt = workspaceRoot ? path.resolve(workspaceRoot) : fsRoot

	while (current !== stopAt && current !== fsRoot) {
		if (fs.existsSync(path.join(current, 'client'))) return current
		if (fs.existsSync(path.join(current, 'frontend'))) return current
		for (const name of AERO_CONFIG_NAMES) {
			if (fs.existsSync(path.join(current, name))) return current
		}
		current = path.dirname(current)
	}
	return undefined
}

export interface PathResolver {
	resolve(specifier: string, fromFile?: string): string | undefined
	root: string
	pagesDir: string
	componentsDir: string
	layoutsDir: string
}

const resolverCache = new Map<string, PathResolver>()

function resolveAeroContentTypes(projectRoot: string): string | undefined {
	const requireFromProject = createRequire(path.join(projectRoot, 'package.json'))
	try {
		const corePkg = requireFromProject.resolve('@aero-js/core/package.json')
		const resolved = createRequire(corePkg).resolve('@aero-js/compiler/env')
		return isExistingFile(resolved) ? resolved : undefined
	} catch {
		try {
			const resolved = requireFromProject.resolve('@aero-js/compiler/env')
			return isExistingFile(resolved) ? resolved : undefined
		} catch {
			return undefined
		}
	}
}

export function getResolver(filePath: string, workspaceRoot?: string): PathResolver {
	const docDir = path.dirname(filePath)
	const rawAliases = loadTsconfigAliases(docDir)
	const projectRoot =
		rawAliases.projectRoot ?? findAeroAppRoot(docDir, workspaceRoot) ?? workspaceRoot ?? docDir

	const cached = resolverCache.get(projectRoot)
	if (cached) return cached

	const { dirs } = loadResolvedAeroConfig(projectRoot)

	const aliasResult = mergeWithDefaultAliases(rawAliases, projectRoot, dirs)
	const resolveFn = aliasResult.resolve

	const clientRoot = path.join(projectRoot, dirs.client)
	const pagesDir = path.join(clientRoot, 'pages')
	const componentsDir = path.join(clientRoot, 'components')
	const layoutsDir = path.join(clientRoot, 'layouts')

	const resolver: PathResolver = {
		root: projectRoot,
		pagesDir,
		componentsDir,
		layoutsDir,
		resolve(specifier: string, fromFile?: string): string | undefined {
			if (/^(https?:|data:|#|\/\/)/.test(specifier)) return undefined

			if (specifier === 'aero:content' || specifier.startsWith('aero:content/')) {
				return resolveAeroContentTypes(projectRoot)
			}

			const importer = fromFile ?? filePath
			const rawResolved = resolveFn(specifier, importer)
			const resolved = resolveImportToFile(specifier, rawResolved)

			return resolved && (resolved !== specifier || /^(\.{1,2}\/|\/|@|~)/.test(specifier)) ?
					resolved
				:	undefined
		},
	}

	resolverCache.set(projectRoot, resolver)
	return resolver
}

export function clearResolverCache(): void {
	resolverCache.clear()
}
