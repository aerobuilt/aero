import type { LanguageInput } from 'shiki'

/**
 * Injection pattern for `{ ... }` expressions in HTML attribute strings.
 * Outer braces use Aero delimiter scopes; expression-body object braces stay TypeScript.
 */
const aeroExpressionPattern = {
	name: 'meta.embedded.block.expression.aero',
	begin: '(\\{)',
	end: '(\\})',
	beginCaptures: {
		'1': {
			name: 'punctuation.section.embedded.begin.aero punctuation.definition.string.begin.html',
		},
	},
	endCaptures: {
		'1': {
			name: 'punctuation.section.embedded.end.aero punctuation.definition.string.end.html',
		},
	},
	contentName: 'meta.embedded.expression.aero source.ts',
	patterns: [
		{
			comment:
				'Object literal body: consume nested braces so outer Aero end is the matching }; inner braces stay TS',
			begin: '\\G\\s*(?=\\{)',
			end: '(?<=\\})',
			patterns: [{ include: 'source.ts#object-literal' }],
		},
		{ include: 'source.ts' },
	],
}

/**
 * Match <slot /> as self-closing void tag (same as aero-vscode).
 * Ensures proper scoping for ligatures and bracket matching.
 */
const slotVoidPattern = {
	begin: '(?i)(<)(slot)\\b(?=[^>]*\\/>)',
	end: '(\\/>)',
	name: 'meta.tag.structure.slot.void.html',
	beginCaptures: {
		'1': { name: 'punctuation.definition.tag.begin.html' },
		'2': { name: 'entity.name.tag.html' },
	},
	endCaptures: {
		'1': { name: 'punctuation.definition.tag.end.html' },
	},
	patterns: [{ include: 'text.html.basic#attribute' }],
}

/**
 * Aero HTML grammar for Shiki.
 *
 * Extends HTML with injection rules that highlight JavaScript/TypeScript inside
 * `{ }` expressions in attribute values (e.g. `props="{ title: site.title }"`).
 * Also matches <slot /> as a self-closing void tag (same as aero-vscode).
 *
 * Use with `langs: [..., aeroHtml]` and fenced blocks tagged ` ```html`.
 * Place aeroHtml at the end of the langs array: it aliases to `html`, and Shiki uses the
 * last-registered handler for a given alias, so putting it last ensures ` ```html ` blocks
 * use this extended grammar instead of the base HTML grammar.
 */
export const aeroHtml: LanguageInput = {
	name: 'aero-html',
	aliases: ['html'],
	scopeName: 'text.html.aero',
	patterns: [slotVoidPattern, { include: 'text.html.basic' }],
	repository: {},
	injections: {
		'string.quoted.double.html': {
			patterns: [aeroExpressionPattern],
		},
		'string.quoted.single.html': {
			patterns: [aeroExpressionPattern],
		},
	},
	embeddedLangs: ['typescript'],
}

/** Language ID for Aero HTML. Use in fenced blocks: ` ```aero-html ` */
export const AERO_HTML_LANG = 'aero-html'
