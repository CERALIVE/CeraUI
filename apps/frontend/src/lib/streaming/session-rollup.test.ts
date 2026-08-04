import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	computeSessionRollup,
	createSample,
	rollupToCsv,
	rollupToJson,
	type SessionSample,
	type SessionSampleLink,
} from "./session-rollup";

/**
 * Per-session ingest rollup + export — device-local only.
 *
 * Drives a deterministic mock session (a known sequence of telemetry samples),
 * stops it (computeSessionRollup), and asserts the summary metrics — including
 * the T7 diagnostic fold: session duration plus per-link contribution (avg
 * weight share), NAK total, and average RTT. Then locks the JSON/CSV export
 * shape, and finally guards that neither the rollup module nor its consumer
 * component reaches for any cloud/platform network surface.
 */

function link(
	iface: string,
	stale: boolean,
	rtt: number,
	nak: number,
	weight: number,
): SessionSampleLink {
	return { iface, stale, rtt, nak, weight };
}

function sample(
	bitrateKbps: number,
	capturedAt: number,
	links: SessionSampleLink[],
): SessionSample {
	return { bitrateKbps, capturedAt, links };
}

// Two bonded links. wlan0 goes stale for samples 3–4 (a single up→down drop),
// while eth0 stays up the whole session. Bitrate is hot-adjusted up then down.
// capturedAt spans 0→15000 ms → duration 15000. eth0 grows its share (50→100)
// as wlan0 falls (50→0); nak counters climb monotonically.
const SESSION: SessionSample[] = [
	sample(4000, 0, [
		link("eth0", false, 10, 0, 50),
		link("wlan0", false, 20, 0, 50),
	]),
	sample(6000, 5000, [
		link("eth0", false, 12, 1, 50),
		link("wlan0", false, 24, 2, 50),
	]),
	sample(8000, 10000, [
		link("eth0", false, 14, 1, 100),
		link("wlan0", true, 40, 5, 0),
	]),
	sample(5000, 15000, [
		link("eth0", false, 16, 1, 100),
		link("wlan0", true, 50, 5, 0),
	]),
];

describe("computeSessionRollup — mock session", () => {
	it("reports peak/avg bitrate, duration, per-link uptime, and the drop count", () => {
		const rollup = computeSessionRollup(SESSION);

		expect(rollup.sampleCount).toBe(4);
		// Peak = max(4000,6000,8000,5000); avg = 23000/4 = 5750.
		expect(rollup.peakBitrateKbps).toBe(8000);
		expect(rollup.avgBitrateKbps).toBe(5750);
		// Duration = last.capturedAt − first.capturedAt = 15000 − 0.
		expect(rollup.durationMs).toBe(15000);

		// Exactly one up→down edge (wlan0 between sample 2 and 3).
		expect(rollup.dropCount).toBe(1);
	});

	it("folds per-link contribution (avg weight share), NAK total, and avg RTT", () => {
		const rollup = computeSessionRollup(SESSION);

		expect(rollup.links).toEqual([
			{
				iface: "eth0",
				uptimePercent: 100,
				// weight avg (50+50+100+100)/4 = 75; rtt avg (10+12+14+16)/4 = 13.
				contribution: 75,
				nakTotal: 1,
				avgRtt: 13,
			},
			{
				iface: "wlan0",
				uptimePercent: 50,
				// weight avg (50+50+0+0)/4 = 25; rtt avg (20+24+40+50)/4 = 33.5 → 34.
				contribution: 25,
				nakTotal: 5,
				avgRtt: 34,
			},
		]);
	});

	it("averages contribution/RTT only over samples the link was present", () => {
		// wlan0 is absent for the middle sample: its contribution + avgRtt are the
		// mean over the two present samples, not diluted by the absence. avgRtt
		// (41+60)/2 = 50.5 rounds to 51 (guards the Math.round at the RTT boundary).
		const diag: SessionSample[] = [
			sample(5000, 1000, [
				link("eth0", false, 15, 0, 70),
				link("wlan0", false, 41, 1, 30),
			]),
			sample(5000, 4000, [link("eth0", false, 25, 3, 80)]),
			sample(5000, 10000, [
				link("eth0", false, 35, 7, 90),
				link("wlan0", false, 60, 4, 10),
			]),
		];
		const rollup = computeSessionRollup(diag);

		expect(rollup.durationMs).toBe(9000);
		expect(rollup.links).toEqual([
			{
				iface: "eth0",
				uptimePercent: 100,
				contribution: 80,
				nakTotal: 7,
				avgRtt: 25,
			},
			{
				iface: "wlan0",
				uptimePercent: 67,
				contribution: 20,
				nakTotal: 4,
				avgRtt: 51,
			},
		]);
		// wlan0 up (s0) → down/absent (s1) → up (s2): one up→down edge.
		expect(rollup.dropCount).toBe(1);
	});

	it("counts a drop for every up→down edge but not the initial down sample", () => {
		// wlan0 flaps: up, down, up, down → two up→down edges. lte0 starts down and
		// never comes up → contributes no drop.
		const flap: SessionSample[] = [
			sample(5000, 0, [
				link("wlan0", false, 30, 0, 60),
				link("lte0", true, 60, 0, 40),
			]),
			sample(5000, 1000, [
				link("wlan0", true, 30, 0, 60),
				link("lte0", true, 60, 0, 40),
			]),
			sample(5000, 2000, [
				link("wlan0", false, 30, 0, 60),
				link("lte0", true, 60, 0, 40),
			]),
			sample(5000, 3000, [
				link("wlan0", true, 30, 0, 60),
				link("lte0", true, 60, 0, 40),
			]),
		];
		const rollup = computeSessionRollup(flap);
		expect(rollup.dropCount).toBe(2);
		expect(rollup.links).toEqual([
			{
				iface: "wlan0",
				uptimePercent: 50,
				contribution: 60,
				nakTotal: 0,
				avgRtt: 30,
			},
			{
				iface: "lte0",
				uptimePercent: 0,
				contribution: 40,
				nakTotal: 0,
				avgRtt: 60,
			},
		]);
	});

	it("zeroes an empty session instead of throwing", () => {
		expect(computeSessionRollup([])).toEqual({
			sampleCount: 0,
			peakBitrateKbps: 0,
			avgBitrateKbps: 0,
			dropCount: 0,
			durationMs: 0,
			links: [],
		});
	});

	it("coerces a missing/invalid bitrate to 0 via createSample", () => {
		const s = createSample(
			undefined,
			[
				{
					iface: "eth0",
					stale: false,
					rtt_ms: 12,
					nak_count: 3,
					weight_percent: 40,
				},
			],
			1234,
		);
		expect(s.bitrateKbps).toBe(0);
		expect(s.capturedAt).toBe(1234);
		expect(s.links).toEqual([
			{ iface: "eth0", stale: false, rtt: 12, nak: 3, weight: 40 },
		]);
		// A full telemetry entry maps every diagnostic field onto the sample link.
		const fromEntry = createSample(
			7000,
			[
				{
					iface: "wlan0",
					stale: true,
					rtt_ms: 47,
					nak_count: 5,
					weight_percent: 60,
				},
			],
			9000,
		);
		expect(fromEntry).toEqual({
			bitrateKbps: 7000,
			capturedAt: 9000,
			links: [{ iface: "wlan0", stale: true, rtt: 47, nak: 5, weight: 60 }],
		});
	});
});

describe("computeSessionRollup — edge cases", () => {
	it("folds a single sample without crediting a phantom drop", () => {
		// One sample → no consecutive pair → no up→down edge can exist, and no
		// wall-clock span → duration 0. A stale link is simply 0% uptime.
		const rollup = computeSessionRollup([
			sample(4000, 5000, [
				link("eth0", false, 10, 0, 50),
				link("wlan0", true, 20, 3, 50),
			]),
		]);
		expect(rollup.sampleCount).toBe(1);
		expect(rollup.peakBitrateKbps).toBe(4000);
		expect(rollup.avgBitrateKbps).toBe(4000);
		expect(rollup.dropCount).toBe(0);
		expect(rollup.durationMs).toBe(0);
		expect(rollup.links).toEqual([
			{
				iface: "eth0",
				uptimePercent: 100,
				contribution: 50,
				nakTotal: 0,
				avgRtt: 10,
			},
			{
				iface: "wlan0",
				uptimePercent: 0,
				contribution: 50,
				nakTotal: 3,
				avgRtt: 20,
			},
		]);
	});

	it("reports 0% uptime and no drops when every link is stale all session", () => {
		// A link that is never up cannot transition up→down, so dropCount stays 0
		// even though both links carry the whole session stale. Contribution/RTT
		// still fold over presence (present-but-stale still counts as present).
		const allStale: SessionSample[] = [
			sample(3000, 0, [
				link("eth0", true, 5, 0, 50),
				link("wlan0", true, 5, 0, 50),
			]),
			sample(3000, 5000, [
				link("eth0", true, 5, 0, 50),
				link("wlan0", true, 5, 0, 50),
			]),
			sample(3000, 10000, [
				link("eth0", true, 5, 0, 50),
				link("wlan0", true, 5, 0, 50),
			]),
		];
		const rollup = computeSessionRollup(allStale);
		expect(rollup.sampleCount).toBe(3);
		expect(rollup.dropCount).toBe(0);
		expect(rollup.avgBitrateKbps).toBe(3000);
		expect(rollup.durationMs).toBe(10000);
		expect(rollup.links).toEqual([
			{
				iface: "eth0",
				uptimePercent: 0,
				contribution: 50,
				nakTotal: 0,
				avgRtt: 5,
			},
			{
				iface: "wlan0",
				uptimePercent: 0,
				contribution: 50,
				nakTotal: 0,
				avgRtt: 5,
			},
		]);
	});

	it("keeps peak/avg at 0 for an all-zero-bitrate session", () => {
		// A configured bitrate of 0 across the session is a valid (idle-encoder)
		// state: peak and avg collapse to 0 while link uptime is still computed.
		const zeroBitrate: SessionSample[] = [
			sample(0, 0, [link("eth0", false, 10, 0, 100)]),
			sample(0, 5000, [link("eth0", false, 10, 0, 100)]),
		];
		const rollup = computeSessionRollup(zeroBitrate);
		expect(rollup.peakBitrateKbps).toBe(0);
		expect(rollup.avgBitrateKbps).toBe(0);
		expect(rollup.links).toEqual([
			{
				iface: "eth0",
				uptimePercent: 100,
				contribution: 100,
				nakTotal: 0,
				avgRtt: 10,
			},
		]);
	});

	it("rounds fractional uptime to the nearest integer percent", () => {
		// eth0 up in 1 of 3 samples → 33.33% → rounds to 33; wlan0 up in 2 of 3 →
		// 66.67% → rounds to 67. Guards the Math.round at the uptime boundary.
		const thirds: SessionSample[] = [
			sample(5000, 0, [
				link("eth0", false, 10, 0, 50),
				link("wlan0", false, 40, 0, 50),
			]),
			sample(5000, 5000, [
				link("eth0", true, 20, 0, 50),
				link("wlan0", false, 50, 0, 50),
			]),
			sample(5000, 10000, [
				link("eth0", true, 30, 0, 50),
				link("wlan0", true, 60, 0, 50),
			]),
		];
		const rollup = computeSessionRollup(thirds);
		expect(rollup.links).toEqual([
			{
				iface: "eth0",
				uptimePercent: 33,
				contribution: 50,
				nakTotal: 0,
				avgRtt: 20,
			},
			{
				iface: "wlan0",
				uptimePercent: 67,
				contribution: 50,
				nakTotal: 0,
				avgRtt: 50,
			},
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
			durationMs: 0,
			links: [],
		});
	});

	it("CSV export keeps the metric block and an empty link block", () => {
		const csv = rollupToCsv(empty);
		expect(csv).toContain("peak_bitrate_kbps,0");
		expect(csv).toContain("avg_bitrate_kbps,0");
		expect(csv).toContain("drop_count,0");
		expect(csv).toContain("sample_count,0");
		expect(csv).toContain("duration_ms,0");
		// The link block header is the final line — no iface rows follow it.
		expect(
			csv
				.trimEnd()
				.endsWith(
					"iface,uptime_percent,contribution_percent,nak_total,avg_rtt_ms",
				),
		).toBe(true);
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
			durationMs: 15000,
			links: [
				{
					iface: "eth0",
					uptimePercent: 100,
					contribution: 75,
					nakTotal: 1,
					avgRtt: 13,
				},
				{
					iface: "wlan0",
					uptimePercent: 50,
					contribution: 25,
					nakTotal: 5,
					avgRtt: 34,
				},
			],
		});
	});

	it("CSV export carries the metric block and a per-link block", () => {
		const csv = rollupToCsv(rollup);
		expect(csv).toContain("peak_bitrate_kbps,8000");
		expect(csv).toContain("avg_bitrate_kbps,5750");
		expect(csv).toContain("drop_count,1");
		expect(csv).toContain("sample_count,4");
		expect(csv).toContain("duration_ms,15000");
		expect(csv).toContain(
			"iface,uptime_percent,contribution_percent,nak_total,avg_rtt_ms",
		);
		// iface,uptime,contribution,nak_total,avg_rtt per link.
		expect(csv).toContain("eth0,100,75,1,13");
		expect(csv).toContain("wlan0,50,25,5,34");
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

/**
 * Cumulative session bytes (srtla_send ADR-002 `bytes_sent_total`).
 *
 * The rollup CARRIES the sender's own counter; it never integrates
 * `bitrateKbps` into one. Integrating on this side loses every byte sent during
 * a missed tick, a page reload, or a link reconnect — precisely why the counter
 * was added to the sender rather than derived here.
 */
describe("computeSessionRollup — cumulative session bytes", () => {
	function byteSample(
		capturedAt: number,
		bytesSentTotal?: number,
	): SessionSample {
		return {
			bitrateKbps: 4000,
			capturedAt,
			...(bytesSentTotal === undefined ? {} : { bytesSentTotal }),
			links: [link("eth0", false, 10, 0, 100)],
		};
	}

	it("reports the final value of the monotonic counter", () => {
		const rollup = computeSessionRollup([
			byteSample(0, 1_000),
			byteSample(5000, 6_000),
			byteSample(10000, 11_000),
		]);

		expect(rollup.bytesSentTotal).toBe(11_000);
	});

	it("survives a last sample that arrived without the counter", () => {
		// The max is taken rather than the last value precisely so a final stale
		// or pre-ADR-002 frame cannot erase a total the operator already saw.
		const rollup = computeSessionRollup([
			byteSample(0, 1_000),
			byteSample(5000, 9_000),
			byteSample(10000, undefined),
		]);

		expect(rollup.bytesSentTotal).toBe(9_000);
	});

	it("stays UNKNOWN when no sample ever reported one — never 0", () => {
		const rollup = computeSessionRollup([byteSample(0), byteSample(5000)]);

		expect(rollup.bytesSentTotal).toBeUndefined();
		// A zero here would tell the operator they transferred nothing.
		expect(rollup.bytesSentTotal).not.toBe(0);
	});

	it("never regresses on a counter that went backwards", () => {
		const rollup = computeSessionRollup([
			byteSample(0, 9_000),
			byteSample(5000, 10),
		]);

		expect(rollup.bytesSentTotal).toBe(9_000);
	});

	it("is CARRIED from the sender, not integrated from the bitrate", () => {
		// A session that sent bytes at a known rate but reported no counter must
		// answer UNKNOWN — proof no client-side integration was reintroduced.
		const rollup = computeSessionRollup([
			sample(8000, 0, [link("eth0", false, 10, 0, 100)]),
			sample(8000, 10_000, [link("eth0", false, 10, 0, 100)]),
		]);

		expect(rollup.avgBitrateKbps).toBe(8000);
		expect(rollup.bytesSentTotal).toBeUndefined();
	});

	it("createSample rejects a malformed counter instead of coercing it to 0", () => {
		expect(
			createSample(4000, [], 0, Number.NaN).bytesSentTotal,
		).toBeUndefined();
		expect(createSample(4000, [], 0, -1).bytesSentTotal).toBeUndefined();
		expect(createSample(4000, [], 0, 1.5).bytesSentTotal).toBeUndefined();
		expect(createSample(4000, [], 0, 4_096).bytesSentTotal).toBe(4_096);
	});

	it("exports the counter in both JSON and CSV", () => {
		const rollup = computeSessionRollup([
			byteSample(0, 1),
			byteSample(1, 2048),
		]);

		expect(JSON.parse(rollupToJson(rollup)).bytesSentTotal).toBe(2048);
		expect(rollupToCsv(rollup)).toContain("bytes_sent_total,2048");
	});

	it("exports an EMPTY CSV cell when the counter is unknown", () => {
		const rollup = computeSessionRollup([byteSample(0)]);

		expect(rollupToCsv(rollup)).toContain("bytes_sent_total,\n");
		expect(rollupToCsv(rollup)).not.toContain("bytes_sent_total,0");
	});
});
