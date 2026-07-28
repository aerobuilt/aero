import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const preamblePath = path.join(packageRoot, 'src/generated/ambient-preamble.ts')
const scriptPath = path.join(packageRoot, 'scripts/generate-ambient-preamble.mjs')

describe('ambient preamble generation', () => {
	it('stays in sync with env.d.ts', () => {
		const before = fs.readFileSync(preamblePath, 'utf-8')
		execFileSync(process.execPath, [scriptPath], { cwd: packageRoot })
		const after = fs.readFileSync(preamblePath, 'utf-8')
		expect(after).toBe(before)
	})
})
