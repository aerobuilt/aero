#!/usr/bin/env node
/**
 * Generate ambient preamble from packages/compiler/env.d.ts.
 *
 * Single source of truth: env.d.ts. Strips comments and splits into
 * BUILD_SCRIPT_PREAMBLE (Aero, renderComponent, raw) and AMBIENT_DECLARATIONS
 * (*.html, *.md, aero:content) for virtual TypeScript checking.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(__dirname, '../env.d.ts')
const outPath = path.resolve(__dirname, '../src/generated/ambient-preamble.ts')

const raw = fs.readFileSync(envPath, 'utf-8')

/** Strip block comments (/** ... *\/ and /* ... *\/) and line comments. */
function stripComments(text) {
	return text
		.replace(/\/\*\*[\s\S]*?\*\//g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
		.replace(/\n\s*\n\s*\n/g, '\n\n')
		.trim()
}

const stripped = stripComments(raw)

const htmlModuleStart = "declare module '*.html'"
const idx = stripped.indexOf(htmlModuleStart)
if (idx === -1) {
	throw new Error("env.d.ts: expected \"declare module '*.html'\" not found")
}

const preamble = stripped.slice(0, idx).trim()
const ambient = stripped.slice(idx).trim()

const outDir = path.dirname(outPath)
if (!fs.existsSync(outDir)) {
	fs.mkdirSync(outDir, { recursive: true })
}

const content = `/**
 * Generated from packages/compiler/env.d.ts - do not edit manually.
 * Run: node scripts/generate-ambient-preamble.mjs
 */

export const BUILD_SCRIPT_PREAMBLE = \`${(preamble + '\n').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`

export const AMBIENT_DECLARATIONS = \`${(ambient + '\n').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`
`

fs.writeFileSync(outPath, content, 'utf-8')
console.log('Generated', outPath)
