import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function collectTsFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__') continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) out.push(...collectTsFiles(full))
		else if (entry.name.endsWith('.ts')) out.push(full)
	}
	return out
}

describe('core import boundary', () => {
	it('production sources only import @aero-js/core/template-diagnostics', () => {
		const files = collectTsFiles(srcRoot)
		const violations: string[] = []

		for (const file of files) {
			const text = fs.readFileSync(file, 'utf-8')
			const importMatches = text.matchAll(/from\s+['"](@aero-js\/core[^'"]*)['"]/g)
			for (const match of importMatches) {
				const spec = match[1]!
				if (spec === '@aero-js/core/template-diagnostics') continue
				violations.push(`${path.relative(srcRoot, file)}: ${spec}`)
			}
		}

		expect(violations).toEqual([])
	})
})
