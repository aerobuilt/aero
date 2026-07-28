/**
 * Re-export the shared interpolation tokenizer from @aero-js/interpolation.
 *
 * @remarks
 * Core uses this for compileInterpolation and compileAttributeInterpolation in helpers.ts.
 * The implementation lives in packages/interpolation so that aero-vscode can depend on
 * the same package without depending on core.
 */

export {
	tokenizeCurlyInterpolation,
	compileInterpolationFromSegments,
	type Segment,
	type LiteralSegment,
	type InterpolationSegment,
} from '@aero-js/interpolation'
