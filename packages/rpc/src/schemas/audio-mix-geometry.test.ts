import { expect, test } from 'bun:test';
import { audioLevelMessageSchema } from './audio-level.schema';
import {
	COMPOSITION_LAYOUTS,
	COMPOSITION_RECT_MIN,
	compositionRectSchema,
} from './streaming.schema';

test('custom geometry never enters the six one-tap presets', () => {
	expect(COMPOSITION_LAYOUTS).toHaveLength(6);
	expect(COMPOSITION_LAYOUTS).not.toContain('custom');
});

test('the producer rectangle is available to geometry consumers', () => {
	expect(COMPOSITION_RECT_MIN).toBe(0.125);
	const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
	expect(compositionRectSchema.parse(rect)).toEqual(rect);
});

test('audio-level RPC retains optional producer input levels', () => {
	const inputs = [{ input_id: 'embedded', channels: 2, rms_db: [-20, -21], peak_db: [-10, -11] }];
	expect(audioLevelMessageSchema.parse({ channels: 2, inputs })).toEqual({ channels: 2, inputs });
	expect(audioLevelMessageSchema.parse({ channels: 2 })).not.toHaveProperty('inputs');
});
