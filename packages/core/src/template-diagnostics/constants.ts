/** Content globals: identifier → alias path. Files in `client/content/` are exposed as globals in Aero templates. */
export const CONTENT_GLOBALS: Record<string, string> = {
	site: '@content/site.ts',
	theme: '@content/theme.ts',
}

export { COMPONENT_SUFFIX_REGEX } from '@aero-js/compiler/constants'
