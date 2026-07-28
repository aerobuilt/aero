import type { AeroContentOptions, AeroOptions } from '../types'

/** Resolve `content: true | AeroContentOptions` to plugin options, or undefined when disabled. */
export function resolveContentOptions(
	content: AeroOptions['content']
): AeroContentOptions | undefined {
	if (content === true) return {}
	if (typeof content === 'object') return content
	return undefined
}

/** Apply plugin defaults and strip `content` (handled separately by `aero()`). */
export function normalizeAeroOptions(options: AeroOptions = {}): Omit<AeroOptions, 'content'> {
	const { content: _content, ...rest } = options
	return {
		...rest,
		server: rest.server ?? false,
		reactivity: rest.reactivity ?? false,
		hypermedia: rest.hypermedia ?? false,
	}
}
