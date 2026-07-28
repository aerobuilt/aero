import { describe, expect, it, vi } from 'vitest'
import type { Plugin } from 'vite'

const aeroContentMock = vi.fn((options?: unknown) => ({
	name: 'vite-plugin-aero-content',
	...(options !== undefined ? { options } : {}),
}))

vi.mock('../load-aero-content', () => ({
	loadAeroContentPlugin: () => aeroContentMock,
}))

vi.mock('vite-plugin-image-optimizer', () => ({
	ViteImageOptimizer: () => ({ name: 'vite-plugin-image-optimizer' }),
}))

vi.mock('nitro/vite', () => ({
	nitro: () => ({ name: 'nitro' }),
}))

import { aero } from '../index'

function pluginName(plugin: unknown): string | undefined {
	if (!plugin || typeof plugin !== 'object') return undefined
	return 'name' in plugin ? String((plugin as Plugin).name) : undefined
}

describe('aero content wiring', () => {
	it('registers aeroContent in returned plugins when content is enabled', () => {
		aeroContentMock.mockClear()
		const plugins = aero({ content: true })
		const names = plugins.flat().map(pluginName)

		expect(aeroContentMock).toHaveBeenCalledWith({})
		expect(names.filter(name => name === 'vite-plugin-aero-content')).toHaveLength(1)
	})

	it('passes content options to aeroContent', () => {
		aeroContentMock.mockClear()
		aero({ content: { config: 'collections.config.ts' } })

		expect(aeroContentMock).toHaveBeenCalledWith({ config: 'collections.config.ts' })
	})

	it('does not register aeroContent when content is omitted', () => {
		aeroContentMock.mockClear()
		const plugins = aero({ server: true })
		const names = plugins.flat().map(pluginName)

		expect(aeroContentMock).not.toHaveBeenCalled()
		expect(names).not.toContain('vite-plugin-aero-content')
	})
})
