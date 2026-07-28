/**
 * Constants for the Aero VS Code extension: selectors and content globals.
 *
 * @remarks
 * COMPONENT_SUFFIX_REGEX comes from `@aero-js/compiler/constants` so the extension
 * stays in sync with the compiler.
 */
import * as vscode from 'vscode'

export { COMPONENT_SUFFIX_REGEX } from '@aero-js/compiler/constants'

/** Content globals: identifier → alias path. Files in `client/content/` are exposed as globals in Aero templates. */
export const CONTENT_GLOBALS: Record<string, string> = {
	site: '@content/site.ts',
	theme: '@content/theme.ts',
}

/** Document selector for HTML templates in Aero projects. */
export const HTML_SELECTOR: vscode.DocumentSelector = [{ language: 'html', scheme: 'file' }]
