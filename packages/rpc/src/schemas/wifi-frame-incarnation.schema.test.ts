import { describe, expect, test } from 'bun:test';
import { wifiMessageSchema } from './wifi.schema.ts';

const frames = [
	{ adapter_mode: { device: 0, mode: 'hotspot', pending: true } },
	{ adapter_mode: { device: '0', mode: 'station', success: true } },
	{ adapter_mode: { device: 0, error: 'not-confirmed' } },
	{ hotspot: { config: { device: 0, success: true } } },
	{ hotspot: { config: { device: '0', error: 'saving' } } },
] as const;

for (const frame of frames) {
	describe(JSON.stringify(frame), () => {
		const bound = (incarnation: unknown) =>
			'adapter_mode' in frame
				? { adapter_mode: { ...frame.adapter_mode, incarnation } }
				: { hotspot: { config: { ...frame.hotspot.config, incarnation } } };

		test('retains the legacy frame without a token', () => {
			expect(wifiMessageSchema.parse(frame)).toEqual(frame);
		});

		for (const token of ['dispatch-A_0', 'x'.repeat(128)]) {
			test(`preserves a valid ${token.length}-character dispatch token`, () => {
				expect(wifiMessageSchema.parse(bound(token))).toEqual(bound(token));
			});
		}

		for (const token of ['', 'x'.repeat(129), 'bad.token', 'a/b', null, 7]) {
			test(`rejects invalid dispatch token ${JSON.stringify(token)}`, () => {
				expect(wifiMessageSchema.safeParse(bound(token)).success).toBe(false);
			});
		}
	});
}
