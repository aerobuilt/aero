import type { AeroDiagnostic } from '@aero-js/diagnostics'
import { isSnippetModulePath } from '../snippets'
import { parseDocument } from './document-analysis'
import { getResolver } from './path-resolver'
import { checkComponentProps } from './checks/check-component-props'
import { checkComponentReferences } from './checks/check-component-references'
import { checkTemplateImportSpecifiers } from './checks/check-template-import-specifiers'
import { checkHypermediaBuildImports } from './checks/check-hypermedia-build-imports'
import { checkConditionalChains } from './checks/check-conditional-chains'
import { checkDirectiveExpressionBraces } from './checks/check-directive-braces'
import { checkDuplicateDeclarations } from './checks/check-duplicate-declarations'
import { checkScriptTags } from './checks/check-script-tags'
import {
	checkUndefinedVariables,
	hasBuildScript,
	hasStateScript,
} from './checks/check-undefined-variables'
import { checkUndefinedScriptVariables } from './checks/check-undefined-script-variables'
import { checkUnusedVariables } from './checks/check-unused-variables'
import { checkRouteContract } from './checks/check-route-contract'
import { checkFeatureGates, type FeatureGateFlags } from './checks/check-feature-gates'
import { checkReadonlyReactivePropWrites } from './checks/check-readonly-reactive-prop-writes'
import { checkReactiveBindingScope } from './checks/check-reactive-binding-scope'
import type { SourceDocument } from './source-document'
import { loadResolvedAeroConfig } from '../config/loadResolvedAeroConfig'

export interface CollectTemplateDiagnosticsInput {
	document: SourceDocument
	root: string
	workspaceRoot?: string
	flags?: FeatureGateFlags
	/**
	 * Optional overlay for cross-file reads (e.g. open unsaved editor buffers).
	 * Return `undefined` to fall back to reading from disk.
	 */
	readTextFile?: (absolutePath: string) => string | undefined
}

export function collectTemplateDiagnostics(input: CollectTemplateDiagnosticsInput): AeroDiagnostic[] {
	const { document, workspaceRoot } = input
	if (isSnippetModulePath(document.uri.fsPath)) {
		return []
	}
	const parsed = parseDocument(document)
	const diagnostics: AeroDiagnostic[] = []
	const resolver = getResolver(document.uri.fsPath, workspaceRoot ?? input.root)
	const { text } = parsed
	const flags = input.flags ?? loadResolvedAeroConfig(resolver.root).flags

	checkScriptTags(document, text, diagnostics, parsed)
	checkConditionalChains(document, text, diagnostics)
	checkDirectiveExpressionBraces(document, text, diagnostics)
	checkTemplateImportSpecifiers(document, text, diagnostics)
	checkHypermediaBuildImports(document, text, diagnostics)
	checkComponentReferences(document, text, diagnostics, resolver)
	checkComponentProps(
		document,
		text,
		diagnostics,
		resolver,
		parsed.definedVariables,
		parsed.variablesByScope.state,
		input.readTextFile
	)
	checkUndefinedScriptVariables(document, parsed, diagnostics)
	checkReadonlyReactivePropWrites(document, parsed, diagnostics)
	checkReactiveBindingScope(document, parsed, diagnostics)
	checkRouteContract(document, diagnostics, resolver)

	if (hasStateScript(parsed) || hasBuildScript(parsed)) {
		checkUndefinedVariables(document, parsed, diagnostics)
	}

	checkUnusedVariables(document, parsed, diagnostics)
	checkDuplicateDeclarations(document, parsed, diagnostics)
	checkFeatureGates(document, text, diagnostics, flags)

	return diagnostics
}

export { parseDocument } from './document-analysis'
export type { ParsedDocument } from './document-analysis'
export { getResolver, clearResolverCache, type PathResolver } from './path-resolver'
export type { SourceDocument, SourceRange, SourcePosition } from './source-document'
export { findAeroProjectRoot, isAeroProjectPath } from './project-scope'
