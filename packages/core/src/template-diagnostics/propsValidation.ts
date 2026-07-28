/**
 * Prop validation: extract required props from TypeScript interfaces and compare
 * with passed props for cross-file validation diagnostics.
 */
import * as fs from 'node:fs'
import {
	analyzeBuildScriptForEditor,
	getPropsTypeFromBuildScript,
	getRequiredPropsFromAeroPropsDestructure,
} from '@aero-js/compiler/build-script-analysis'
import type { PathResolver } from './path-resolver'
import { parseScriptBlocks } from './script-tag'

const TYPE_IMPORT_REGEX = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g

export interface ParsedInterface {
	required: string[]
	optional: string[]
}

const INTERFACE_REGEX = /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/g
const PROPERTY_REGEX = /([A-Za-z_$][\w$]*)\s*\??\s*:/g

export function parseInterfaceBody(body: string): ParsedInterface {
	const required: string[] = []
	const optional: string[] = []
	let match: RegExpExecArray | null
	PROPERTY_REGEX.lastIndex = 0
	while ((match = PROPERTY_REGEX.exec(body)) !== null) {
		const fullMatch = match[0]
		const name = match[1]
		const isOptional = fullMatch.includes('?')
		if (isOptional) {
			optional.push(name)
		} else {
			required.push(name)
		}
	}
	return { required, optional }
}

export function findInterfaceInSource(
	source: string,
	interfaceName: string
): ParsedInterface | null {
	INTERFACE_REGEX.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = INTERFACE_REGEX.exec(source)) !== null) {
		if (match[1] === interfaceName) {
			return parseInterfaceBody(match[2])
		}
	}
	return null
}

export function getRequiredPropsFromType(
	typeName: string,
	componentContent: string,
	componentPath: string,
	resolver: PathResolver
): string[] | null {
	const inline = findInterfaceInSource(componentContent, typeName)
	if (inline) {
		return inline.required.length > 0 ? inline.required : null
	}

	const buildScript = getBuildScriptContent(componentContent)
	if (!buildScript) return null

	TYPE_IMPORT_REGEX.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = TYPE_IMPORT_REGEX.exec(buildScript)) !== null) {
		const importedNames = match[1].split(',').map(s =>
			s
				.trim()
				.split(/\s+as\s+/)[0]
				.trim()
		)
		const specifier = match[2]
		if (importedNames.includes(typeName)) {
			const resolved = resolver.resolve(specifier, componentPath)
			if (!resolved || !fs.existsSync(resolved)) return null
			const content = fs.readFileSync(resolved, 'utf-8')
			const parsed = findInterfaceInSource(content, typeName)
			if (parsed) {
				return parsed.required.length > 0 ? parsed.required : null
			}
		}
	}

	const { imports } = analyzeBuildScriptForEditor(buildScript)
	for (const imp of imports) {
		for (const { imported, local } of imp.namedBindings) {
			if (local === typeName || imported === typeName) {
				const resolved = resolver.resolve(imp.specifier, componentPath)
				if (!resolved || !fs.existsSync(resolved)) return null
				const content = fs.readFileSync(resolved, 'utf-8')
				const parsed = findInterfaceInSource(content, imported)
				if (parsed) {
					return parsed.required.length > 0 ? parsed.required : null
				}
			}
		}
	}
	return null
}

/**
 * Resolve required build props for a component: prefer `as Type` interface `?`,
 * otherwise infer from `const { … } = Aero.props` destructuring defaults.
 */
export function getRequiredPropsFromComponent(
	componentContent: string,
	componentPath: string,
	resolver: PathResolver
): string[] | null {
	const buildScript = getBuildScriptContent(componentContent)
	if (!buildScript) return null

	const propsType = getPropsTypeFromBuildScript(buildScript)
	if (propsType) {
		return getRequiredPropsFromType(
			propsType.typeName,
			componentContent,
			componentPath,
			resolver
		)
	}

	const fromDestructure = getRequiredPropsFromAeroPropsDestructure(buildScript)
	return fromDestructure.length > 0 ? fromDestructure : null
}

export function getKeysFromObjectLiteral(literal: string): string[] {
	const keys: string[] = []
	const keyRegex = /(?:\{\s*|,\s*)([A-Za-z_$][\w$]*)(?=\s*[,:}])/g
	let match: RegExpExecArray | null
	while ((match = keyRegex.exec(literal)) !== null) {
		keys.push(match[1])
	}
	return keys
}

export function getPropsTypeFromComponent(
	componentContent: string
): { typeName: string; isFromDestructuring: boolean } | null {
	const buildScript = getBuildScriptContent(componentContent)
	if (!buildScript) return null
	return getPropsTypeFromBuildScript(buildScript)
}

function getBuildScriptContent(htmlContent: string): string | null {
	const buildBlocks = parseScriptBlocks(htmlContent).filter(b => b.kind === 'build')
	return buildBlocks.length > 0 ? buildBlocks[0].content : null
}
