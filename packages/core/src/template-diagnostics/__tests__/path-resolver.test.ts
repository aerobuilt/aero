import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getResolver } from '../path-resolver'

const kitchenSinkPage = path.join(
	import.meta.dirname,
	'../../../../../examples/kitchen-sink/client/pages/docs/index.html'
)
const kitchenSinkRoot = path.join(import.meta.dirname, '../../../../../examples/kitchen-sink')

describe('getResolver aero:content', () => {
	it('resolves aero:content to compiler env.d.ts', () => {
		const resolver = getResolver(kitchenSinkPage, kitchenSinkRoot)
		const resolved = resolver.resolve('aero:content')
		expect(resolved).toMatch(/packages[/\\]compiler[/\\]env\.d\.ts$/)
	})

	it('resolves aero:content/<collection> to the same types file', () => {
		const resolver = getResolver(kitchenSinkPage, kitchenSinkRoot)
		const resolved = resolver.resolve('aero:content/docs')
		expect(resolved).toMatch(/packages[/\\]compiler[/\\]env\.d\.ts$/)
	})
})
