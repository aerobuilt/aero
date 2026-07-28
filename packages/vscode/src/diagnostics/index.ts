import * as vscode from 'vscode'
import * as fs from 'node:fs'
import { collectTemplateDiagnostics } from '@aero-js/core/template-diagnostics'
import { isAeroDocument } from '../scope'
import { mapAeroDiagnosticToVscode } from './map-aero-diagnostic'

function openFileTextOverlays(): Map<string, string> {
	const overlays = new Map<string, string>()
	for (const doc of vscode.workspace.textDocuments) {
		if (doc.uri.scheme !== 'file') continue
		const text = doc.getText()
		overlays.set(doc.uri.fsPath, text)
		try {
			overlays.set(fs.realpathSync.native?.(doc.uri.fsPath) ?? fs.realpathSync(doc.uri.fsPath), text)
		} catch {
			/* unsaved or missing on disk */
		}
	}
	return overlays
}

export function collectDiagnosticsForDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
	const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
	const overlays = openFileTextOverlays()

	return collectTemplateDiagnostics({
		document,
		root: workspaceRoot ?? document.uri.fsPath,
		workspaceRoot,
		readTextFile: absolutePath => {
			const direct = overlays.get(absolutePath)
			if (direct !== undefined) return direct
			try {
				return overlays.get(fs.realpathSync(absolutePath))
			} catch {
				return undefined
			}
		},
	}).map(mapAeroDiagnosticToVscode)
}

export function registerDiagnostics(context: vscode.ExtensionContext): vscode.Disposable {
	const collection = vscode.languages.createDiagnosticCollection('aero')
	const disposables: vscode.Disposable[] = []

	const updateDiagnostics = (document: vscode.TextDocument): void => {
		if (!isAeroDocument(document)) {
			collection.delete(document.uri)
			return
		}

		collection.set(document.uri, collectDiagnosticsForDocument(document))
	}

	/** Cross-file contracts (bindable props, required props) read sibling templates — refresh all open Aero docs. */
	const updateAllOpenAeroDiagnostics = (): void => {
		for (const doc of vscode.workspace.textDocuments) {
			updateDiagnostics(doc)
		}
	}

	disposables.push(
		vscode.workspace.onDidOpenTextDocument(doc => updateDiagnostics(doc)),
		vscode.workspace.onDidSaveTextDocument(() => updateAllOpenAeroDiagnostics()),
		vscode.workspace.onDidChangeTextDocument(() => updateAllOpenAeroDiagnostics()),
		vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri))
	)

	updateAllOpenAeroDiagnostics()

	const disposable: vscode.Disposable = {
		dispose(): void {
			collection.dispose()
			for (const d of disposables) d.dispose()
		},
	}

	context.subscriptions.push(disposable)
	return disposable
}
