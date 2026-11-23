import { describe, expect, test } from 'bun:test';

import { hotspotConfigSchema, wifiNewInputSchema } from './wifi.schema';

describe('Wi-Fi join BSSID input', () => {
	const open = { device: '0', ssid: 'Guest', password: '', security: '' };

	test('accepts a valid six-octet BSSID', () => {
		const request = { ...open, bssid: '02:00:00:00:51:AA' };
		expect(wifiNewInputSchema.parse(request)).toEqual(request);
	});

	test.each(['02:00:00:00:51', 'not-a-bssid', '00:00:00:00:00:00', ''])(
		'rejects invalid supplied BSSID %j at the wire boundary',
		(bssid) => {
			const result = wifiNewInputSchema.safeParse({ ...open, bssid });
			expect(result.success).toBe(false);
			expect(result.error?.issues[0]?.path).toEqual(['bssid']);
		},
	);

	test('admits omission so the handler can return a typed refusal', () => {
		expect(wifiNewInputSchema.parse(open)).toEqual(open);
	});

	test('keeps the legacy password-bearing request valid without BSSID', () => {
		const legacy = { device: '0', ssid: 'Home', password: 'test-password' };
		expect(wifiNewInputSchema.parse(legacy)).toEqual(legacy);
	});
});

const channels = { auto: { name: 'Automatic' } };
const wpa2 = { name: 'WPA2 (Personal)' };
const sae = { name: 'WPA3 (SAE)' };

describe('hotspot security offering output', () => {
	test.each([{ wpa2 }, { wpa2, 'wpa3-sae': sae }, { 'wpa3-sae': sae }])(
		'accepts a nonempty subset of security modes: %j',
		(offering) => {
			expect(
				hotspotConfigSchema.parse({
					available_channels: channels,
					available_security: offering,
				}).available_security,
			).toEqual(offering);
		},
	);

	test('keeps the existing all-keys output bytes even for reversed input keys', () => {
		const parsed = hotspotConfigSchema.parse({
			available_channels: channels,
			available_security: { 'wpa3-sae': sae, wpa2 },
		});
		expect(JSON.stringify(parsed.available_security)).toBe(
			'{"wpa2":{"name":"WPA2 (Personal)"},"wpa3-sae":{"name":"WPA3 (SAE)"}}',
		);
	});

	test('keeps an omitted legacy offering absent', () => {
		expect(hotspotConfigSchema.parse({ available_channels: channels })).toEqual({
			available_channels: channels,
		});
	});

	test('rejects a prototype-named unknown key from JSON', () => {
		const offering: unknown = JSON.parse(
			'{"wpa2":{"name":"WPA2"},"wpa3-sae":{"name":"SAE"},"__proto__":{"name":"Open"}}',
		);
		expect(
			hotspotConfigSchema.safeParse({
				available_channels: channels,
				available_security: offering,
			}).success,
		).toBe(false);
	});

	test.each([
		{},
		{ wpa2, 'wpa3-sae': sae, open: { name: 'Open' } },
		{ wpa2, 'wpa3-sae': sae, 'wpa2-wpa3-mixed': { name: 'Mixed' } },
		{ wpa2: { name: 42 }, 'wpa3-sae': sae },
		{ wpa2: 'WPA2', 'wpa3-sae': sae },
		{ wpa2: null, 'wpa3-sae': sae },
		{ wpa2: undefined, 'wpa3-sae': sae },
	])('still rejects an empty or malformed offering: %j', (offering) => {
		expect(
			hotspotConfigSchema.safeParse({
				available_channels: channels,
				available_security: offering,
			}).success,
		).toBe(false);
	});
});
