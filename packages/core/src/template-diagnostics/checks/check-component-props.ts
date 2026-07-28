/**
 * Diagnostic check: cross-file prop validation for components and layouts.
 */

import type { AeroDiagnostic } from '@aero-js/diagnostics'
import type { SourceDocument } from '../source-document'
import * as fs from 'node:fs'
import { COMPONENT_SUFFIX_REGEX } from '../constants'
import type { PathResolver } from '../path-resolver'
import type { VariableDefinition } from '../analyzer'
import { kebabToCamelCase, collectImportedSpecifiersFromDocument } from '../utils'
import { isValidTemplateImportSpecifier } from '../importResolution'
import { getRequiredPropsFromComponent } from '../propsValidation'
import { getIgnoredRanges, isInRanges } from './helpers'
import {
	resolvePropsSpreadVariable,
	validateIndividualAttrs,
	validateSpreadProps,
} from './component-required-props'
import { validateComponentReactiveProps, validateComponentBindRequiresState } from './component-reactive-props'
import { traceLayoutToSinkProps } from './layout-props-chain'

export { resolvePropsSpreadVariable } from './component-required-props'

/** Matches opening tags with component/layout suffix */
const COMPONENT_TAG_OPEN_REGEX =
	/<([a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:component|layout))\b[^>]*\/?>/gi

export function checkComponentProps(
	document: SourceDocument,
	text: string,
	diagnostics: AeroDiagnostic[],
	resolver: PathResolver,
	definedVars: Map<string, VariableDefinition>,
	stateVars: Map<string, VariableDefinition> = new Map(),
	readTextFile?: (absolutePath: string) => string | undefined
): void {
	const imports = collectImportedSpecifiersFromDocument(text)
	const ignoredRanges = getIgnoredRanges(text)

	COMPONENT_TAG_OPEN_REGEX.lastIndex = 0
	let match: RegExpExecArray | null

	while ((match = COMPONENT_TAG_OPEN_REGEX.exec(text)) !== null) {
		const tagStart = match.index
		if (isInRanges(tagStart, ignoredRanges)) continue

		const tagName = match[1]
		const fullTag = match[0]
		const attrs = fullTag.slice(1 + tagName.length, -1).trim()
		const suffixMatch = COMPONENT_SUFFIX_REGEX.exec(tagName)
		if (!suffixMatch) continue

		const baseName = tagName.replace(COMPONENT_SUFFIX_REGEX, '')
		const importName = kebabToCamelCase(baseName)
		const importedSpecifier = imports.get(importName)
		if (!importedSpecifier || !isValidTemplateImportSpecifier(importedSpecifier)) continue

		const rawResolved = resolver.resolve(importedSpecifier, document.uri.fsPath)
		const resolvedPath =
			rawResolved && fs.existsSync(rawResolved) ? rawResolved : null
		if (!resolvedPath) continue

		const suffix = suffixMatch[1] as string
		if (suffix === 'component' || suffix === 'layout') {
			validateComponentBindRequiresState(
				document,
				diagnostics,
				tagStart,
				fullTag,
				tagName,
				stateVars
			)
		}
		if (suffix === 'component') {
			validateComponentReactiveProps(
				document,
				diagnostics,
				tagStart,
				fullTag,
				tagName,
				baseName,
				importName,
				resolvedPath,
				stateVars,
				readTextFile
			)
		}

		// Layout: trace chain to sink component; validate bare/spread props or individual attrs
		if (suffix === 'layout') {
			const sink = traceLayoutToSinkProps(resolvedPath, resolver)
			if (sink?.requiredProps?.length) {
				const spreadVar = resolvePropsSpreadVariable(attrs)
				if (spreadVar) {
					validateSpreadProps(
						document,
						diagnostics,
						tagStart,
						tagName,
						spreadVar,
						sink.requiredProps,
						definedVars,
						baseName,
						suffix
					)
				} else {
					validateIndividualAttrs(
						document,
						diagnostics,
						tagStart,
						tagName,
						attrs,
						sink.requiredProps,
						baseName,
						suffix
					)
				}
			}
			continue
		}

		// Component: check props="{ ...varName }"
		const componentContent =
			readTextFile?.(resolvedPath) ??
			(() => {
				try {
					return readTextFile?.(fs.realpathSync(resolvedPath))
				} catch {
					return undefined
				}
			})() ??
			fs.readFileSync(resolvedPath, 'utf-8')
		const requiredProps = getRequiredPropsFromComponent(
			componentContent,
			resolvedPath,
			resolver
		)
		if (!requiredProps || requiredProps.length === 0) continue

		const spreadVar = resolvePropsSpreadVariable(attrs)
		if (spreadVar) {
			validateSpreadProps(
				document,
				diagnostics,
				tagStart,
				tagName,
				spreadVar,
				requiredProps,
				definedVars,
				baseName,
				suffix
			)
		} else {
			validateIndividualAttrs(
				document,
				diagnostics,
				tagStart,
				tagName,
				attrs,
				requiredProps,
				baseName,
				suffix
			)
		}
	}
}
