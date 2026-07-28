import { describe, expect, it } from 'vitest'
import { loadAeroContentPlugin } from '../load-aero-content'

describe('loadAeroContentPlugin', () => {
	it('throws a clear error when @aero-js/content cannot be resolved', () => {
		expect(() =>
			loadAeroContentPlugin(() => {
				throw new Error('Cannot find module')
			})
		).toThrow(/@aero-js\/content/)
	})

	it('returns aeroContent from the resolved module', () => {
		const factory = () => ({ name: 'vite-plugin-aero-content' })
		const loaded = loadAeroContentPlugin(() => ({ aeroContent: factory as never }))
		expect(loaded).toBe(factory)
	})
})
