import { expect, test } from 'bun:test';
import { statusResponseSchema } from './status.schema';
import {
	hotspotConfigInputSchema,
	hotspotPrepareInputSchema,
	hotspotToggleInputSchema,
	setWifiAdapterModeInputSchema,
	wifiStatusSchema,
} from './wifi.schema';

const legacyRow = { ifname: 'wlan0', conn: '', hw: 'radio', saved: {} };
const requests = [
	{ name: 'prepare load', schema: hotspotPrepareInputSchema, input: { device: '0' } },
	{
		name: 'prepare save',
		schema: hotspotPrepareInputSchema,
		input: { device: '0', name: 'Test AP', password: 'password1' },
	},
	{ name: 'start/stop', schema: hotspotToggleInputSchema, input: { device: '0' } },
	{
		name: 'configure',
		schema: hotspotConfigInputSchema,
		input: { device: '0', name: 'Test AP', password: 'password1', channel: 'auto' },
	},
	...(['station', 'hotspot', 'hybrid'] as const).map((mode) => ({
		name: `mode ${mode}`,
		schema: setWifiAdapterModeInputSchema,
		input: { device: '0', mode },
	})),
];

for (const incarnation of [undefined, 'opaque-future-token', 'Az_09-test', 'a'.repeat(128)]) {
	test(`Wi-Fi and full status preserve optional opaque token ${JSON.stringify(incarnation)}`, () => {
		const row = { ...legacyRow, ...(incarnation === undefined ? {} : { incarnation }) };
		const wifi = { '0': row };
		expect(wifiStatusSchema.parse(wifi)).toStrictEqual(wifi);
		expect(statusResponseSchema.parse({ wifi })).toStrictEqual({ wifi });
		const parsed = wifiStatusSchema.parse(wifi);
		const { incarnation: _incarnation, ...parsedLegacy } = parsed['0'] ?? {};
		expect(JSON.stringify({ '0': parsedLegacy })).toBe(JSON.stringify({ '0': legacyRow }));
	});
	for (const { name, schema, input } of requests) {
		test(`${name} accepts optional opaque token ${JSON.stringify(incarnation)}`, () => {
			const request = { ...input, ...(incarnation === undefined ? {} : { incarnation }) };
			expect(schema.parse(request)).toStrictEqual(request);
		});
	}
}

for (const incarnation of [
	'',
	null,
	42,
	true,
	[],
	{},
	'a'.repeat(129),
	' ',
	'quote"\\token',
	'line\r\nbreak',
	'nul\0token',
	'not.ascii',
	'é',
	'token\n',
	'token\r',
]) {
	test(`Wi-Fi status rejects malformed or empty token ${JSON.stringify(incarnation)}`, () => {
		expect(wifiStatusSchema.safeParse({ '0': { ...legacyRow, incarnation } }).success).toBe(false);
	});
	for (const { name, schema, input } of requests) {
		test(`${name} rejects malformed or empty token ${JSON.stringify(incarnation)}`, () => {
			expect(schema.safeParse({ ...input, incarnation }).success).toBe(false);
		});
	}
}

test('mode switch still rejects unknown input keys beside a valid token', () => {
	expect(
		setWifiAdapterModeInputSchema.safeParse({
			device: '0',
			mode: 'station',
			incarnation: 'opaque',
			unrecognized: true,
		}).success,
	).toBe(false);
});
