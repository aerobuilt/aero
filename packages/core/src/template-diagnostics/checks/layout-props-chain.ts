/**
 * Layout chain tracing: follow layout → layout → sink component for required props.
 */

import * as fs from 'node:fs'
import { COMPONENT_SUFFIX_REGEX } from '../constants'
import type { PathResolver } from '../path-resolver'
import { kebabToCamelCase, collectImportedSpecifiersFromDocument } from '../utils'
import { getRequiredPropsFromComponent } from '../propsValidation'

/** Maximum layout chain depth to prevent infinite loops. */
const MAX_LAYOUT_CHAIN_DEPTH = 10

/**
 * Trace a layout file to find the sink component that consumes props.
 * Follows layout -> layout -> component chain (e.g. sub -> base -> meta).
 */
export function traceLayoutToSinkProps(
	layoutPath: string,
	resolver: PathResolver
): { requiredProps: string[] } | null {
	const visited = new Set<string>()
	let currentPath = layoutPath
	for (let i = 0; i < MAX_LAYOUT_CHAIN_DEPTH; i++) {
		if (visited.has(currentPath)) break
		visited.add(currentPath)
		const content = fs.readFileSync(currentPath, 'utf-8')
		// Find child that receives props
		const childMatch = content.match(
			/<([a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:component|layout))\b[^>]*\b(?:data-)?props\b[^>]*\/?>/i
		)
		if (!childMatch) break
		const childTag = childMatch[1]
		const childBase = childTag.replace(COMPONENT_SUFFIX_REGEX, '')
		const childImport = kebabToCamelCase(childBase)
		const imports = collectImportedSpecifiersFromDocument(content)
		const spec = imports.get(childImport)
		if (!spec) break
		const childResolved = resolver.resolve(spec, currentPath)
		const childPath =
			childResolved && fs.existsSync(childResolved) ? childResolved : null
		if (!childPath) break
		if (childTag.endsWith('-component')) {
			const compContent = fs.readFileSync(childPath, 'utf-8')
			const required = getRequiredPropsFromComponent(compContent, childPath, resolver)
			return required?.length ? { requiredProps: required } : null
		}
		currentPath = childPath
	}
	return null
}
