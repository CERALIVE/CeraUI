import { expect, test } from 'bun:test';
import {
	COMPOSITION_GEOMETRY_FEATURE,
	compositionRectFits,
	streamingSetConfigInputSchema,
} from './streaming.schema';

test('a placement fits only inside the frame with every side at least the minimum', () => {
	expect(compositionRectFits({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 })).toBe(true);
	expect(compositionRectFits({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
	expect(compositionRectFits({ x: 0.875, y: 0.875, width: 0.125, height: 0.125 })).toBe(true);
	expect(compositionRectFits({ x: 0.6, y: 0, width: 0.5, height: 0.5 })).toBe(false);
	expect(compositionRectFits({ x: 0, y: 0.9, width: 0.5, height: 0.125 })).toBe(false);
	expect(compositionRectFits({ x: 0, y: 0, width: 0.1, height: 0.5 })).toBe(false);
	expect(compositionRectFits({ x: 0, y: 0, width: 0.5, height: 0.124 })).toBe(false);
	expect(compositionRectFits({ x: -0.01, y: 0, width: 0.5, height: 0.5 })).toBe(false);
	expect(compositionRectFits({ x: Number.NaN, y: 0, width: 0.5, height: 0.5 })).toBe(false);
});

test('setConfig carries a placement as its own field, next to the apply-now directive', () => {
	const rect = { x: 0.05, y: 0.45, width: 0.5, height: 0.5 };
	expect(
		streamingSetConfigInputSchema.parse({ composition_rect: rect, apply_now: true }),
	).toMatchObject({
		composition_rect: rect,
		apply_now: true,
	});
	expect(COMPOSITION_GEOMETRY_FEATURE).toBe('composition-geometry');
});
