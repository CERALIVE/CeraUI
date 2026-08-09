/*
 * `deviceStatsSchema` — the ADDITIVE guard.
 *
 * The payload grew optional signals (memory/swap, and more to follow). These
 * tests pin the two properties that make such growth safe:
 *
 *   1. a payload emitted by a device that predates the optional fields still
 *      parses — otherwise a schema bump would blank the panel of every device
 *      that has not been updated yet;
 *   2. the five always-present keys are still REQUIRED — "additive" must not
 *      quietly become "everything is optional now".
 */
import { describe, expect, test } from 'bun:test';

import { deviceStatsSchema } from './system.schema.js';

const LEGACY_PAYLOAD = {
	disk: { used: 100, total: 200, type: 'eMMC' },
	cpuLoad1: 1.25,
	socTemp: 48.3,
	ifaceRxTx: { iface: 'eth0', rxBytesPerSec: 10, txBytesPerSec: 20 },
	raucSlot: 'rootfs.0',
};

describe('deviceStatsSchema — additive growth', () => {
	test('a pre-memory (five-key) payload still parses', () => {
		const parsed = deviceStatsSchema.parse(LEGACY_PAYLOAD);
		expect(parsed.raucSlot).toBe('rootfs.0');
		expect(parsed.memTotalBytes).toBeUndefined();
	});

	test('a payload carrying the memory signals parses them through', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			memTotalBytes: 4294967296,
			memAvailableBytes: 3221225472,
			memUsedPercent: 25,
			swapTotalBytes: 0,
			swapFreeBytes: 0,
		});
		expect(parsed.memUsedPercent).toBe(25);
		// A measured zero survives as a zero — it must never be dropped as falsy.
		expect(parsed.swapTotalBytes).toBe(0);
		expect(parsed.swapFreeBytes).toBe(0);
	});

	test('a payload carrying the per-policy CPU frequencies parses them through', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			cpuFreq: [
				{ id: 'policy0', curKhz: 1008000, maxKhz: 1800000 },
				{ id: 'policy4', curKhz: 1416000, maxKhz: 2400000 },
			],
		});
		expect(parsed.cpuFreq).toHaveLength(2);
		// kHz on the wire — a schema that silently accepted GHz would let a
		// producer ship 1.8 where consumers expect 1800000.
		expect(parsed.cpuFreq?.[0]?.maxKhz).toBe(1800000);
		expect(parsed.cpuFreq?.[1]?.id).toBe('policy4');
	});

	test('a pre-cpuFreq payload still parses (the field is absent, not empty)', () => {
		const parsed = deviceStatsSchema.parse(LEGACY_PAYLOAD);
		expect(parsed.cpuFreq).toBeUndefined();
	});

	test('the five always-present keys stay REQUIRED', () => {
		for (const key of ['disk', 'cpuLoad1', 'socTemp', 'ifaceRxTx', 'raucSlot'] as const) {
			const { [key]: _dropped, ...withoutKey } = LEGACY_PAYLOAD;
			expect(deviceStatsSchema.safeParse(withoutKey).success).toBe(false);
		}
	});
});
