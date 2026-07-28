/**
 * Unit tests for compiler helpers (helpers.ts): interpolation, attributes, props string building,
 * slot/conditional/loop emitters, and related utilities.
 */

import { describe, it, expect } from 'vitest'
import { escapeScriptJson } from '../../escapes'
import {
	compileInterpolation,
	compileReactiveTextReadExpr,
	compileAttributeInterpolation,
	isAttr,
	stripBraces,
	kebabToCamelCase,
	buildPropsString,
	escapeBackticks,
	emitSlotsObjectVars,
	emitRenderFunction,
	emitSlotVar,
	emitAppend,
	emitIf,
	emitElseIf,
	emitElse,
	emitEnd,
	emitSlotOutput,
	RENDER_INTERNAL_CONTEXT_KEYS,
	getRenderComponentContextArg,
	getRenderContextDestructurePattern,
} from '../../helpers'

describe('compileInterpolation', () => {
	it('should return empty string for empty input', () => {
		expect(compileInterpolation('')).toBe('')
	})

	it('should convert {expr} to ${escapeHtml(expr)} with auto-escaping', () => {
		expect(compileInterpolation('hello {name}')).toBe('hello ${escapeHtml(name)}')
	})

	it('should escape backticks', () => {
		expect(compileInterpolation('hello `world`')).toBe('hello \\`world\\`')
	})

	it('should escape backslashes in literal text', () => {
		expect(compileInterpolation('cost \\ total')).toBe('cost \\\\ total')
	})

	it('should handle multiple interpolations', () => {
		expect(compileInterpolation('{a} and {b}')).toBe('${escapeHtml(a)} and ${escapeHtml(b)}')
	})

	it('should escape HTML in literal text for safe HTML output', () => {
		expect(compileInterpolation('<script is:state>')).toBe('&lt;script is:state&gt;')
		expect(compileInterpolation('a & b')).toBe('a &amp; b')
	})

	it('should passthrough raw(), trim(), trimStart(), and trimEnd() calls', () => {
		expect(compileInterpolation('{ raw(html) }')).toBe('${ raw(html) }')
		expect(compileInterpolation('{ trim(text) }')).toBe('${ trim(text) }')
		expect(compileInterpolation('{ trimStart(text) }')).toBe('${ trimStart(text) }')
		expect(compileInterpolation('{ trimEnd(text) }')).toBe('${ trimEnd(text) }')
	})

	it('should treat adjacent {{ as nested JS in text content', () => {
		expect(compileInterpolation('{{ literal }}')).toBe('${escapeHtml({ literal })}')
	})
})

describe('compileReactiveTextReadExpr', () => {
	it('escapes expression segments only, preserving literal quotes', () => {
		expect(compileReactiveTextReadExpr('{ count }')).toBe('escapeHtml(String( count ))')
		expect(compileReactiveTextReadExpr('bind:count="{ count }"')).toBe(
			'"bind:count=\\"" + escapeHtml(String( count )) + "\\""'
		)
		expect(compileReactiveTextReadExpr('{ `bind:count="{ ${count} }"` }')).toBe(
			'escapeHtml(String( `bind:count="{ ${count} }"` ))'
		)
	})
})

describe('compileAttributeInterpolation', () => {
	it('should return empty string for empty input', () => {
		expect(compileAttributeInterpolation('')).toBe('')
	})

	it('should convert {expr} to ${expr}', () => {
		expect(compileAttributeInterpolation('{name}')).toBe('${name}')
	})

	it('should escape backticks', () => {
		expect(compileAttributeInterpolation('`test`')).toBe('\\`test\\`')
	})

	it('should escape backslashes in literal text', () => {
		expect(compileAttributeInterpolation('path \\ value')).toBe('path \\\\ value')
	})

	it('should treat adjacent {{ as nested JS', () => {
		expect(compileAttributeInterpolation('{{ literal }}')).toBe('${{ literal }}')
	})

	it('should treat {{ {expr} }} as nested JS', () => {
		expect(compileAttributeInterpolation('{{ {expr} }}')).toBe('${{ {expr} }}')
	})
})

describe('isAttr', () => {
	it('should match exact attribute name', () => {
		expect(isAttr('if', 'if', 'data-')).toBe(true)
		expect(isAttr('is:build', 'is:build', '')).toBe(true)
	})

	it('should match prefixed attribute name', () => {
		expect(isAttr('if', 'if', 'data-')).toBe(true)
		expect(isAttr('for', 'for', 'data-')).toBe(true)
	})

	it('should not match unrelated attributes', () => {
		expect(isAttr('class', 'if', 'data-')).toBe(false)
		expect(isAttr('href', 'if', 'data-')).toBe(false)
	})
})

describe('stripBraces', () => {
	it('should strip surrounding braces', () => {
		expect(stripBraces('{expr}')).toBe('expr')
	})

	it('should handle whitespace', () => {
		expect(stripBraces('{ expr }')).toBe('expr')
	})

	it('should not modify string without braces', () => {
		expect(stripBraces('expr')).toBe('expr')
	})
})

describe('kebabToCamelCase', () => {
	it('should convert kebab to camelCase', () => {
		expect(kebabToCamelCase('my-component')).toBe('myComponent')
	})

	it('should handle multiple hyphens', () => {
		expect(kebabToCamelCase('my-long-component-name')).toBe('myLongComponentName')
	})

	it('should handle single word', () => {
		expect(kebabToCamelCase('component')).toBe('component')
	})
})

describe('buildPropsString', () => {
	it('should build props with entries only', () => {
		expect(buildPropsString(['title="Hello"'], null)).toBe('{ title="Hello" }')
	})

	it('should build props with spread only', () => {
		expect(buildPropsString([], 'props')).toBe('{ props }')
	})

	it('should build props with spread and entries', () => {
		expect(buildPropsString(['title="Hello"'], 'props')).toBe('{ props, title="Hello" }')
	})

	it('should handle multiple entries', () => {
		expect(buildPropsString(['a="1"', 'b="2"'], null)).toBe('{ a="1", b="2" }')
	})
})

describe('escapeBackticks', () => {
	it('should escape backticks', () => {
		expect(escapeBackticks('hello `world`')).toBe('hello \\`world\\`')
	})

	it('should handle no backticks', () => {
		expect(escapeBackticks('hello world')).toBe('hello world')
	})

	it('should escape backslashes and ${ sequences for template literals', () => {
		expect(escapeBackticks('path \\ ${value}')).toBe('path \\\\ \\${value}')
	})
})

describe('emitSlotsObjectVars', () => {
	it('should emit slots object', () => {
		expect(emitSlotsObjectVars({ default: '__slot_default' })).toBe('{ "default": __slot_default }')
	})

	it('should handle multiple slots', () => {
		expect(emitSlotsObjectVars({ default: '__s1', header: '__s2' })).toBe(
			'{ "default": __s1, "header": __s2 }'
		)
	})

	it('should handle empty object', () => {
		expect(emitSlotsObjectVars({})).toBe('{  }')
	})
})

describe('emitRenderFunction', () => {
	it('should emit render function without getStaticPaths', () => {
		const result = emitRenderFunction('const name = "test"', '__out += name')
		expect(result).toContain('export default async function(Aero)')
		expect(result).toContain('const name = "test"')
	})

	it('should include getStaticPaths when provided', () => {
		const getStaticPathsFn = 'export async function getStaticPaths() { return [] }'
		const result = emitRenderFunction('', '', { getStaticPathsFn })
		expect(result).toContain('export async function getStaticPaths() { return [] }')
		expect(result).toContain('export default async function(Aero)')
	})

	it('should include styleCode and rootScriptsLines when provided', () => {
		const result = emitRenderFunction('', '__out += "x";', {
			styleCode: 'styles?.add("<style>");',
			rootScriptsLines: ['scripts?.add("<script src=a>");'],
		})
		expect(result).toContain('styles?.add("<style>");')
		expect(result).toContain('scripts?.add("<script src=a>");')
		expect(result).toContain('headScripts')
	})
})

describe('emitSlotVar', () => {
	it('should emit slot variable declaration', () => {
		expect(emitSlotVar('header')).toBe("let header = '';\n")
	})
})

describe('emitAppend', () => {
	it('should emit append statement', () => {
		expect(emitAppend('hello')).toBe('__out += `hello`;\n')
	})

	it('should use custom output variable', () => {
		expect(emitAppend('hello', '__html')).toBe('__html += `hello`;\n')
	})
})

describe('emitIf', () => {
	it('should emit if statement', () => {
		expect(emitIf('condition')).toBe('if (condition) {\n')
	})
})

describe('emitElseIf', () => {
	it('should emit else if statement', () => {
		expect(emitElseIf('condition')).toBe('} else if (condition) {\n')
	})
})

describe('emitElse', () => {
	it('should emit else statement', () => {
		expect(emitElse()).toBe('} else {\n')
	})
})

describe('emitEnd', () => {
	it('should emit closing brace', () => {
		expect(emitEnd()).toBe('}\n')
	})
})

describe('emitSlotOutput', () => {
	it('should emit slot output', () => {
		expect(emitSlotOutput('default', 'content')).toBe('__out += slots["default"] ?? `content`;\n')
	})

	it('should use custom output variable', () => {
		expect(emitSlotOutput('header', 'h', '__html')).toBe('__html += slots["header"] ?? `h`;\n')
	})

	it('escapes backticks in default content and JSON-encodes slot name', () => {
		expect(emitSlotOutput('a"b', 'x`y')).toBe('__out += slots["a\\"b"] ?? `x\\`y`;\n')
	})

	it('preserves ${…} in default content for nested codegen', () => {
		const body = '${ await Aero.renderComponent(x, {}, {}, ctx) }'
		expect(emitSlotOutput('default', body)).toBe(`__out += slots["default"] ?? \`${body}\`;\n`)
	})
})

describe('renderComponent context (single source of truth)', () => {
	it('RENDER_INTERNAL_CONTEXT_KEYS includes only internal plumbing keys', () => {
		expect(RENDER_INTERNAL_CONTEXT_KEYS).toEqual(['styles', 'scripts', 'headScripts'])
	})

	it('getRenderComponentContextArg forwards page/site from Aero and internal keys', () => {
		const arg = getRenderComponentContextArg()
		expect(arg).toContain('page: Aero.page')
		expect(arg).toContain('site: Aero.site')
		expect(arg).toContain('styles')
		expect(arg).toContain('scripts')
		expect(arg).toContain('headScripts')
		// Must NOT contain old aliases
		expect(arg).not.toContain('__aero_site')
		expect(arg).not.toContain('injectedHeadScripts')
	})

	it('getRenderContextDestructurePattern includes slots, renderComponent, and internal keys only', () => {
		const pattern = getRenderContextDestructurePattern()
		expect(pattern).toContain('slots = {}')
		expect(pattern).toContain('renderComponent')
		expect(pattern).toContain('headScripts')
		expect(pattern).toContain('formatAttributeBind')
		// Must NOT destructure page or site (they stay on Aero)
		expect(pattern).not.toContain('page')
		expect(pattern).not.toContain('site')
		// Must NOT contain old aliases
		expect(pattern).not.toContain('injectedHeadScripts')
	})

	it('emitRenderFunction destructuring matches getRenderContextDestructurePattern', () => {
		const fn = emitRenderFunction('', '')
		expect(fn).toContain(getRenderContextDestructurePattern())
	})
})

describe('escapeScriptJson', () => {
	it('serializes Map and Set with __aero markers', () => {
		const json = escapeScriptJson({
			numbersMap: new Map([[1, 'one']]),
			numbersSet: new Set([1, 2, 3]),
		})
		expect(json).toContain('"__aero":"Map"')
		expect(json).toContain('"entries":[[1,"one"]]')
		expect(json).toContain('"__aero":"Set"')
		expect(json).toContain('"values":[1,2,3]')
	})
})
