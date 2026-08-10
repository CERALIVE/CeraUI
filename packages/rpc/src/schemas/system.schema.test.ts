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

import { deviceStatsSchema, encoderLoadSchema } from './system.schema.js';

const LEGACY_PAYLOAD = {
	disk: { used: 100, total: 200, type: 'eMMC' },
	cpuLoad1: 1.25,
	socTemp: 48.3,
	ifaceRxTx: { iface: 'eth0', rxBytesPerSec: 10, txBytesPerSec: 20 },
	raucSlot: 'rootfs.0',
};

/** Every field the contract carries today — the removal/rename guard's subject. */
const FULL_PAYLOAD = {
	...LEGACY_PAYLOAD,
	memTotalBytes: 8589934592,
	memAvailableBytes: 6442450944,
	memUsedPercent: 25,
	swapTotalBytes: 2147483648,
	swapFreeBytes: 2147483648,
	cpuFreq: [
		{ id: 'policy0', curKhz: 1008000, maxKhz: 1800000 },
		{ id: 'policy4', curKhz: 1416000, maxKhz: 2400000 },
		{ id: 'policy6', curKhz: 2016000, maxKhz: 2400000 },
	],
	ddr: { loadPercent: 37, curFreqHz: 528000000, maxFreqHz: 1560000000 },
	gpu: { loadPercent: 61, curFreqHz: 300000000, maxFreqHz: 1000000000 },
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

	test('a payload carrying the DDR-bus reading parses it through', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			ddr: { loadPercent: 23, curFreqHz: 528000000, maxFreqHz: 1560000000 },
		});
		expect(parsed.ddr?.loadPercent).toBe(23);
		// Hz, not the kHz `cpuFreq` carries — a schema that accepted either would
		// let a producer ship a figure 1000x off the consumer's scale.
		expect(parsed.ddr?.curFreqHz).toBe(528000000);
	});

	test('a pre-ddr payload still parses (the field is absent, not zero-filled)', () => {
		const parsed = deviceStatsSchema.parse(LEGACY_PAYLOAD);
		expect(parsed.ddr).toBeUndefined();
	});

	test('a measured 0% DDR load survives — it is not dropped as falsy', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			ddr: { loadPercent: 0, curFreqHz: 528000000, maxFreqHz: 1560000000 },
		});
		expect(parsed.ddr?.loadPercent).toBe(0);
	});

	test('a payload carrying the devfreq-shaped GPU reading parses it through', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			gpu: { loadPercent: 63, curFreqHz: 300000000, maxFreqHz: 1000000000 },
		});
		expect(parsed.gpu?.loadPercent).toBe(63);
		// Hz like `ddr`, NOT the kHz `cpuFreq` carries.
		expect(parsed.gpu?.maxFreqHz).toBe(1000000000);
	});

	test('a kbase-shaped GPU reading (load ONLY) parses — the frequencies are optional in their own right', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			gpu: { loadPercent: 42 },
		});
		expect(parsed.gpu?.loadPercent).toBe(42);
		expect(parsed.gpu?.curFreqHz).toBeUndefined();
		expect(parsed.gpu?.maxFreqHz).toBeUndefined();
	});

	test('a pre-gpu payload still parses (the field is absent, not zero-filled)', () => {
		const parsed = deviceStatsSchema.parse(LEGACY_PAYLOAD);
		expect(parsed.gpu).toBeUndefined();
	});

	test('a measured 0% GPU load survives — it is not dropped as falsy', () => {
		const parsed = deviceStatsSchema.parse({
			...LEGACY_PAYLOAD,
			gpu: { loadPercent: 0 },
		});
		expect(parsed.gpu?.loadPercent).toBe(0);
	});

	test('a GPU reading with NO load is rejected — load is the reading itself', () => {
		expect(
			deviceStatsSchema.safeParse({
				...LEGACY_PAYLOAD,
				gpu: { curFreqHz: 300000000 },
			}).success,
		).toBe(false);
	});

	test('the five always-present keys stay REQUIRED', () => {
		for (const key of ['disk', 'cpuLoad1', 'socTemp', 'ifaceRxTx', 'raucSlot'] as const) {
			const { [key]: _dropped, ...withoutKey } = LEGACY_PAYLOAD;
			expect(deviceStatsSchema.safeParse(withoutKey).success).toBe(false);
		}
	});

	// The whole-payload lock. The per-signal tests above each assert a couple of
	// representative keys; this one round-trips EVERY field at once, so dropping
	// or renaming any single one — required or optional, top level or nested —
	// makes zod strip it and the `toEqual` fail. Growth stays a one-line edit
	// here; removal cannot be silent.
	test('every field currently on the contract survives a round trip', () => {
		expect(deviceStatsSchema.parse(FULL_PAYLOAD)).toEqual(FULL_PAYLOAD);
	});
});

const LEGACY_ENCODER_LOAD = {
	source: 'mpp-service',
	cores: [
		{ core: 'rkvenc0', kind: 'percent', percent: 11.34 },
		{ core: 'rkvenc1', kind: 'percent', percent: 0 },
	],
	updatedAt: 1800000000000,
	simulated: false,
};

describe('encoderLoadSchema — additive growth', () => {
	test('a pre-decode payload still parses, and stays absent rather than empty', () => {
		const parsed = encoderLoadSchema.parse(LEGACY_ENCODER_LOAD);
		expect(parsed.decodeCores).toBeUndefined();
		// Not `[]`: a device that said nothing about decode must not be reported
		// as having measured its decoders at nothing.
		expect('decodeCores' in parsed).toBe(false);
	});

	test('a vendor payload carrying decoder rows parses them through', () => {
		const parsed = encoderLoadSchema.parse({
			...LEGACY_ENCODER_LOAD,
			decodeCores: [
				{ core: 'rkvdec0', kind: 'percent', percent: 23.1 },
				{ core: 'rkvdec1', kind: 'unavailable' },
			],
		});
		expect(parsed.decodeCores).toHaveLength(2);
		// The refused row keeps its slot — dropping it would renumber rkvdec1.
		expect(parsed.decodeCores?.[1]).toEqual({ core: 'rkvdec1', kind: 'unavailable' });
	});

	test('decoder rows are not limited to the encoder\u2019s two slots', () => {
		const parsed = encoderLoadSchema.parse({
			...LEGACY_ENCODER_LOAD,
			decodeCores: [
				{ core: 'rkvdec0', kind: 'percent', percent: 1 },
				{ core: 'rkvdec1', kind: 'percent', percent: 2 },
				{ core: 'rkvdec2', kind: 'percent', percent: 3 },
			],
		});
		expect(parsed.decodeCores).toHaveLength(3);
	});

	test('the pre-existing keys stay REQUIRED', () => {
		for (const key of ['source', 'cores', 'updatedAt', 'simulated'] as const) {
			const { [key]: _dropped, ...withoutKey } = LEGACY_ENCODER_LOAD;
			expect(encoderLoadSchema.safeParse(withoutKey).success).toBe(false);
		}
	});

	test('every field currently on the contract survives a round trip', () => {
		const full = {
			...LEGACY_ENCODER_LOAD,
			decodeCores: [{ core: 'rkvdec0', kind: 'percent', percent: 23.1 }],
		};
		expect(encoderLoadSchema.parse(full)).toEqual(full);
	});
});
