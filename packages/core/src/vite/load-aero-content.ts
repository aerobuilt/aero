/**
 * Lazily load the optional `@aero-js/content` Vite plugin.
 *
 * Kept out of core's hard dependency graph so content can depend on core without a cycle.
 */
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'
import type { AeroContentOptions } from '../types'

type AeroContentFactory = (options?: AeroContentOptions) => Plugin

const defaultRequire = createRequire(import.meta.url)

/** Sync require used to resolve `@aero-js/content/vite` (injectable for tests). */
export type AeroContentRequire = (id: string) => { aeroContent: AeroContentFactory }

export function loadAeroContentPlugin(
	requireFn: AeroContentRequire = defaultRequire as AeroContentRequire
): AeroContentFactory {
	try {
		return requireFn('@aero-js/content/vite').aeroContent
	} catch {
		throw new Error(
			'content: true requires `@aero-js/content`. Install it in your project (e.g. `pnpm add @aero-js/content`).'
		)
	}
}
