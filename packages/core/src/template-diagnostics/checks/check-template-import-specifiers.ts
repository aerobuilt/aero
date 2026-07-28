import type { AeroDiagnostic } from '@aero-js/diagnostics'
import { pushOffsetDiagnostic, pushSpanDiagnostic } from '../aero-diagnostic-build'
import { rangeFromOffsets, type SourceDocument, type SourceRange } from '../source-document'
/**
 * Diagnostic check: template imports must include an explicit `.html` extension.
 */
import { analyzeBuildScriptForEditor } from '@aero-js/compiler/build-script-analysis'
import { isTemplateAliasSpecifier } from '../importResolution'
import { parseScriptBlocks } from '../script-tag'

export function checkTemplateImportSpecifiers(
	document: SourceDocument,
	text: string,
	diagnostics: AeroDiagnostic[]
): void {
	for (const block of parseScriptBlocks(text)) {
		if (block.kind !== 'build') continue
		if (!block.content.trim()) continue

		let imports: ReturnType<typeof analyzeBuildScriptForEditor>['imports'] = []
		try {
			imports = analyzeBuildScriptForEditor(block.content).imports
		} catch {
			continue
		}

		for (const imp of imports) {
			if (!isTemplateAliasSpecifier(imp.specifier) || imp.specifier.endsWith('.html')) continue

			const [specStart, specEnd] = imp.specifierRange
			const absStart = block.contentStart + specStart
			const absEnd = block.contentStart + specEnd
			pushOffsetDiagnostic(
				diagnostics,
				document,
				absStart,
				absEnd,
				`Template imports must include the .html extension (for example '${imp.specifier}.html').`,
				'AERO_RESOLVE',
				'error'
			)
		}
	}
}
