import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	computeSessionRollup,
	createSample,
	rollupToCsv,
	rollupToJson,
	type SessionSample,
} from "./session-rollup";

/**
 * Per-session ingest rollup + export — device-local only.
 *
 * Drives a deterministic mock session (a known sequence of telemetry samples),
 * stops it (computeSessionRollup), and asserts the summary metrics. Then locks
 * the JSON/CSV export shape, and finally guards that neither the rollup module
 * nor its consumer component reaches for any cloud/platform network surface.
 */

// Two bonded links. wlan0 goes stale for samples 3–4 (a single up→down drop),
// while eth0 stays up the whole session. Bitrate is hot-adjusted up then down.
const SESSION: SessionSample[] = [
	{
		bitrateKbps: 4000,
		links: [
			{ iface: "eth0", stale: false },
			{ iface: "wlan0", stale: false },
		],
	},
	{
		bitrateKbps: 6000,
		links: [
			{ iface: "eth0", stale: false },
			{ iface: "wlan0", stale: false },
		],
	},
	{
		bitrateKbps: 8000,
		links: [
			{ iface: "eth0", stale: false },
			{ iface: "wlan0", stale: true },
		],
	},
	{
		bitrateKbps: 5000,
		links: [
			{ iface: "eth0", stale: false },
			{ iface: "wlan0", stale: true },
		],
	},
];

describe("computeSessionRollup — mock session", () => {
	it("reports peak/avg bitrate, per-link uptime, and the drop count", () => {
		const rollup = computeSessionRollup(SESSION);

		expect(rollup.sampleCount).toBe(4);
		// Peak = max(4000,6000,8000,5000); avg = 23000/4 = 5750.
		expect(rollup.peakBitrateKbps).toBe(8000);
		expect(rollup.avgBitrateKbps).toBe(5750);

		// eth0 up in all 4 samples → 100%; wlan0 up in 2 of 4 → 50%.
		expect(rollup.links).toEqual([
			{ iface: "eth0", uptimePercent: 100 },
			{ iface: "wlan0", uptimePercent: 50 },
		]);

		// Exactly one up→down edge (wlan0 between sample 2 and 3).
		expect(rollup.dropCount).toBe(1);
	});

	it("counts a drop for every up→down edge but not the initial down sample", () => {
		// wlan0 flaps: up, down, up, down → two up→down edges. A link that starts
		// down (never up) contributes no drop.
		const flap: SessionSample[] = [
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "wlan0", stale: false },
					{ iface: "lte0", stale: true },
				],
			},
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "wlan0", stale: true },
					{ iface: "lte0", stale: true },
				],
			},
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "wlan0", stale: false },
					{ iface: "lte0", stale: true },
				],
			},
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "wlan0", stale: true },
					{ iface: "lte0", stale: true },
				],
			},
		];
		const rollup = computeSessionRollup(flap);
		expect(rollup.dropCount).toBe(2);
		expect(rollup.links).toEqual([
			{ iface: "wlan0", uptimePercent: 50 },
			{ iface: "lte0", uptimePercent: 0 },
		]);
	});

	it("zeroes an empty session instead of throwing", () => {
		expect(computeSessionRollup([])).toEqual({
			sampleCount: 0,
			peakBitrateKbps: 0,
			avgBitrateKbps: 0,
			dropCount: 0,
			links: [],
		});
	});

	it("coerces a missing/invalid bitrate to 0 via createSample", () => {
		const sample = createSample(undefined, [{ iface: "eth0", stale: false }]);
		expect(sample.bitrateKbps).toBe(0);
		expect(sample.links).toEqual([{ iface: "eth0", stale: false }]);
		// A telemetry entry carries more fields; only iface + stale are retained.
		const fromEntry = createSample(7000, [{ iface: "wlan0", stale: true }]);
		expect(fromEntry).toEqual({
			bitrateKbps: 7000,
			links: [{ iface: "wlan0", stale: true }],
		});
	});
});

describe("computeSessionRollup — edge cases", () => {
	it("folds a single sample without crediting a phantom drop", () => {
		// One sample → no consecutive pair → no up→down edge can exist. A stale
		// link in that lone sample is simply 0% uptime, not a drop.
		const rollup = computeSessionRollup([
			{
				bitrateKbps: 4000,
				links: [
					{ iface: "eth0", stale: false },
					{ iface: "wlan0", stale: true },
				],
			},
		]);
		expect(rollup.sampleCount).toBe(1);
		expect(rollup.peakBitrateKbps).toBe(4000);
		expect(rollup.avgBitrateKbps).toBe(4000);
		expect(rollup.dropCount).toBe(0);
		expect(rollup.links).toEqual([
			{ iface: "eth0", uptimePercent: 100 },
			{ iface: "wlan0", uptimePercent: 0 },
		]);
	});

	it("reports 0% uptime and no drops when every link is stale all session", () => {
		// A link that is never up cannot transition up→down, so dropCount stays 0
		// even though both links carry the whole session stale.
		const allStale: SessionSample[] = [
			{
				bitrateKbps: 3000,
				links: [
					{ iface: "eth0", stale: true },
					{ iface: "wlan0", stale: true },
				],
			},
			{
				bitrateKbps: 3000,
				links: [
					{ iface: "eth0", stale: true },
					{ iface: "wlan0", stale: true },
				],
			},
			{
				bitrateKbps: 3000,
				links: [
					{ iface: "eth0", stale: true },
					{ iface: "wlan0", stale: true },
				],
			},
		];
		const rollup = computeSessionRollup(allStale);
		expect(rollup.sampleCount).toBe(3);
		expect(rollup.dropCount).toBe(0);
		expect(rollup.avgBitrateKbps).toBe(3000);
		expect(rollup.links).toEqual([
			{ iface: "eth0", uptimePercent: 0 },
			{ iface: "wlan0", uptimePercent: 0 },
		]);
	});

	it("keeps peak/avg at 0 for an all-zero-bitrate session", () => {
		// A configured bitrate of 0 across the session is a valid (idle-encoder)
		// state: peak and avg collapse to 0 while link uptime is still computed.
		const zeroBitrate: SessionSample[] = [
			{ bitrateKbps: 0, links: [{ iface: "eth0", stale: false }] },
			{ bitrateKbps: 0, links: [{ iface: "eth0", stale: false }] },
		];
		const rollup = computeSessionRollup(zeroBitrate);
		expect(rollup.peakBitrateKbps).toBe(0);
		expect(rollup.avgBitrateKbps).toBe(0);
		expect(rollup.links).toEqual([{ iface: "eth0", uptimePercent: 100 }]);
	});

	it("rounds fractional uptime to the nearest integer percent", () => {
		// eth0 up in 1 of 3 samples → 33.33% → rounds to 33; wlan0 up in 2 of 3 →
		// 66.67% → rounds to 67. Guards the Math.round at the uptime boundary.
		const thirds: SessionSample[] = [
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "eth0", stale: false },
					{ iface: "wlan0", stale: false },
				],
			},
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "eth0", stale: true },
					{ iface: "wlan0", stale: false },
				],
			},
			{
				bitrateKbps: 5000,
				links: [
					{ iface: "eth0", stale: true },
					{ iface: "wlan0", stale: true },
				],
			},
		];
		const rollup = computeSessionRollup(thirds);
		expect(rollup.links).toEqual([
			{ iface: "eth0", uptimePercent: 33 },
			{ iface: "wlan0", uptimePercent: 67 },
		]);
	});
});

describe("rollup export — empty session", () => {
	// The export path must serialise a zeroed rollup without emitting any per-link
	// rows (no links → only the header line survives in the CSV link block).
	const empty = computeSessionRollup([]);

	it("JSON export carries zeroed fields and an empty links array", () => {
		expect(JSON.parse(rollupToJson(empty))).toEqual({
			sampleCount: 0,
			peakBitrateKbps: 0,
			avgBitrateKbps: 0,
			dropCount: 0,
			links: [],
		});
	});

	it("CSV export keeps the metric block and an empty link block", () => {
		const csv = rollupToCsv(empty);
		expect(csv).toContain("peak_bitrate_kbps,0");
		expect(csv).toContain("avg_bitrate_kbps,0");
		expect(csv).toContain("drop_count,0");
		expect(csv).toContain("sample_count,0");
		// The link block header is the final line — no iface rows follow it.
		expect(csv.trimEnd().endsWith("iface,uptime_percent")).toBe(true);
	});
});

describe("rollup export — JSON and CSV", () => {
	const rollup = computeSessionRollup(SESSION);

	it("JSON export carries every summary field", () => {
		const parsed = JSON.parse(rollupToJson(rollup));
		expect(parsed).toEqual({
			sampleCount: 4,
			peakBitrateKbps: 8000,
			avgBitrateKbps: 5750,
			dropCount: 1,
			links: [
				{ iface: "eth0", uptimePercent: 100 },
				{ iface: "wlan0", uptimePercent: 50 },
			],
		});
	});

	it("CSV export carries the metric block and a per-link block", () => {
		const csv = rollupToCsv(rollup);
		expect(csv).toContain("peak_bitrate_kbps,8000");
		expect(csv).toContain("avg_bitrate_kbps,5750");
		expect(csv).toContain("drop_count,1");
		expect(csv).toContain("sample_count,4");
		expect(csv).toContain("iface,uptime_percent");
		expect(csv).toContain("eth0,100");
		expect(csv).toContain("wlan0,50");
	});
});

describe("device-local guarantee — no cloud/platform calls", () => {
	// The summary + export path must never transmit. Static-scan the rollup module
	// and the IngestStats consumer for any network surface.
	const here = path.dirname(new URL(import.meta.url).pathname);
	const files = [
		path.resolve(here, "session-rollup.ts"),
		path.resolve(here, "../components/custom/IngestStats.svelte"),
	];

	it("contains no fetch/XHR/WebSocket/rpc network surface", () => {
		// Scan the rpc *call* surface (`rpc.`, `rpcClient`) — a type-only import from
		// `@ceraui/rpc/schemas` is not a network call and must not trip the guard.
		const forbidden = [
			/\bfetch\s*\(/,
			/XMLHttpRequest/,
			/\bnew\s+WebSocket\b/,
			/\brpc\./,
			/\brpcClient\b/,
			/https?:\/\//,
			/navigator\.sendBeacon/,
		];
		for (const file of files) {
			const src = fs.readFileSync(file, "utf8");
			for (const pattern of forbidden) {
				expect(
					pattern.test(src),
					`${path.basename(file)} must not match ${pattern}`,
				).toBe(false);
			}
		}
	});
});
