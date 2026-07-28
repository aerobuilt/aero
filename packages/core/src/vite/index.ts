/**
 * Aero Vite plugin: HTML transform, virtual modules, dev server middleware, and static build.
 *
 * @remarks
 * Split into focused sub-plugins: config, virtuals (resolve/load), transform, SSR middleware.
 * Static build plugin runs after closeBundle; Nitro and image optimizer are composed in the factory.
 */

import type { AeroOptions, ScriptEntry } from '../types'
import type { Plugin, PluginOption } from 'vite'
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer'
import { nitro } from 'nitro/vite'
import { DEFAULT_API_PREFIX, resolveDirs } from './defaults'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aeroCssErrorLocationPlugin } from './aero-css-error-location-plugin'
import { aeroCssImportHmrPlugin } from './aero-css-import-hmr-plugin'
import { createAeroConfigPlugin } from './aero-config-plugin'
import { createAeroVirtualsPlugin } from './aero-virtuals-plugin'
import { createAeroTransformPlugin } from './aero-transform-plugin'
import { createAeroSsrPlugin } from './aero-ssr-plugin'
import { createAeroStaticBuildPlugin } from './aero-static-build-plugin'
import { resolveAeroNitroPluginsForVite } from './nitro-config'
import { normalizeAeroOptions, resolveContentOptions } from './resolve-aero-options'
import { loadAeroContentPlugin } from './load-aero-content'
import type { AeroPluginState } from './plugin-state'

export type { CompileWarningPayload } from './compile-warning-dedup'
export { flushCompileWarnings } from './compile-warning-dedup'

/**
 * Aero Vite plugin factory. Returns an array of plugins: config, virtuals, transform, SSR,
 * static-build, image optimizer, and optionally Nitro (serve only).
 * HMR for templates and content is handled by Vite's dependency graph when the app uses a single
 * client entry that imports @aero-js/core and calls aero.mount().
 *
 * @param options - AeroOptions (content, server, apiPrefix, dirs). Server can be disabled at runtime via AERO_SERVER=false.
 * @returns PluginOption[] to pass to Vite's plugins array.
 */
export function aero(rawOptions: AeroOptions = {}): PluginOption[] {
	const contentOptions = resolveContentOptions(rawOptions.content)
	const aeroContent = contentOptions !== undefined ? loadAeroContentPlugin() : undefined
	const options = normalizeAeroOptions(rawOptions)
	const staticServerPlugins = [
		...(options.staticServerPlugins ?? []),
		...(aeroContent !== undefined && contentOptions !== undefined
			? [aeroContent(contentOptions)]
			: []),
	]
	const pluginOptions: Omit<AeroOptions, 'content'> = {
		...options,
		staticServerPlugins: staticServerPlugins.length > 0 ? staticServerPlugins : undefined,
	}
	const dirs = resolveDirs(pluginOptions.dirs)
	const apiPrefix = pluginOptions.apiPrefix || DEFAULT_API_PREFIX
	const enableNitro = pluginOptions.server === true && process.env.AERO_SERVER !== 'false'

	const runtimeInstanceMjsPath = fileURLToPath(new URL('../runtime/instance.mjs', import.meta.url))
	const runtimeInstanceJsPath = fileURLToPath(new URL('../runtime/instance.js', import.meta.url))
	const runtimeInstanceTsPath = fileURLToPath(new URL('../runtime/instance.ts', import.meta.url))
	const runtimeInstancePath = existsSync(runtimeInstanceMjsPath)
		? runtimeInstanceMjsPath
		: existsSync(runtimeInstanceJsPath)
			? runtimeInstanceJsPath
			: runtimeInstanceTsPath

	const state: AeroPluginState = {
		config: null,
		aliasResult: null,
		clientScripts: new Map<string, ScriptEntry>(),
		templateDiscovery: null,
		runtimeInstancePath,
		generatedRuntimeInstancePath: null,
		generatedStateBindingsRegistryPath: null,
		dirs,
		apiPrefix,
		options: pluginOptions,
		compileWarningHashes: new Map<string, string>(),
		staticBuildFailed: false,
	}

	const aeroConfigPlugin = createAeroConfigPlugin(state)
	const aeroVirtualsPlugin = createAeroVirtualsPlugin(state)
	const aeroTransformPlugin = createAeroTransformPlugin(state)
	const aeroSsrPlugin = createAeroSsrPlugin(state)

	/** Plugins needed for static build (resolve, load, transform); no SSR/HMR. */
	const aeroCorePlugins: Plugin[] = [aeroConfigPlugin, aeroVirtualsPlugin, aeroTransformPlugin]

	const staticBuildPlugin = createAeroStaticBuildPlugin(state, {
		pluginOptions,
		apiPrefix,
		dirs,
		enableNitro,
		aeroCorePlugins,
	})

	const plugins: PluginOption[] = [
		aeroConfigPlugin,
		aeroVirtualsPlugin,
		aeroTransformPlugin,
		aeroSsrPlugin,
		aeroCssErrorLocationPlugin(dirs.client),
		aeroCssImportHmrPlugin(),
		staticBuildPlugin,
		ViteImageOptimizer({
			exclude: undefined,
			include: undefined,
			includePublic: true,
			logStats: true,
			ansiColors: true,
			svg: {
				multipass: true,
				plugins: [
					{
						name: 'preset-default',
						params: {
							overrides: {
								cleanupNumericValues: false,
							},
							cleanupIDs: {
								minify: false,
								remove: false,
							},
							convertPathData: false,
						},
					},
				],
			},
			png: { quality: 80 },
			jpeg: { quality: 80 },
			jpg: { quality: 80 },
			tiff: { quality: 80 },
			gif: {},
			webp: { lossless: true },
			avif: { lossless: true },
		}),
	]

	if (enableNitro) {
		const root = process.cwd()
		const aeroNitroPlugins = resolveAeroNitroPluginsForVite(root)
		const rawNitroPlugins = nitro({
			serverDir: dirs.server,
			plugins: aeroNitroPlugins,
		})
		const nitroPlugins = Array.isArray(rawNitroPlugins) ? rawNitroPlugins : [rawNitroPlugins]
		for (const nitroPlugin of nitroPlugins) {
			if (!nitroPlugin || typeof nitroPlugin !== 'object') continue
			const originalApply = nitroPlugin.apply
			plugins.push({
				...nitroPlugin,
				apply(pluginConfig, env) {
					if (env.command !== 'serve') return false
					if ((env as { isPreview?: boolean }).isPreview) return false
					if (typeof originalApply === 'function') {
						return originalApply(pluginConfig, env)
					}
					if (originalApply) return originalApply === 'serve'
					return true
				},
			})
		}
	}

	if (aeroContent !== undefined && contentOptions !== undefined) {
		plugins.push(aeroContent(contentOptions))
	}

	return plugins
}

export { DEFAULT_DIRS, resolveDirs } from './defaults'
export {
	discoverReactivePagePaths,
	discoverRuntimeTemplatePaths,
} from './runtime-template-discovery'
