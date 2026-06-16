import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Rust-sender telemetry skew guard (Phase D · Cutover).
//
// At the C → Rust srtla_send cutover the *producer* of the telemetry stats file
// changes, but the CeraUI *consumer* (`readTelemetry` from
// `@ceralive/srtla-send/telemetry`) must keep reading it verbatim. This test
// proves that compatibility end-to-end: it writes the exact ADR-001 stats
// document the Rust sender publishes (`src/telemetry_file.rs`,
// `build_telemetry_json` → atomic `rename(2)`) and asserts the CeraUI reader
// parses it into the typed snapshot the `linkTelemetry` flow depends on.
//
// The contract being skew-tested (srtla-send-rs AGENTS.md → PARITY CONTRACT):
//   {"schema_version":1,"last_updated_ms":<ms>,"connections":[
//     {"conn_id","rtt_ms","nak_count","weight_percent","window","in_flight","bitrate_bps"}]}
//   - schema_version is the literal 1 (Rust adds it; the reader validates it).
//   - rtt_ms is the Kalman-smoothed RTT — non-zero while streaming.
//   - bitrate_bps is wire-bytes/s × 8 (the mandatory ×8 conversion).
//
// Why this is a real (would-be-RED) test, not a tautology: the reader is
// deliberately STRICTER than the C-era `@ceralive/srtla` reader — it validates
// `schema_version` as a literal `1` and keeps `window`/`in_flight` mandatory. A
// "missing or mismatched" reader (e.g. one that ignored `schema_version` or had
// dropped a required field) would either fail to surface a non-zero Kalman
// `rtt_ms` from the Rust producer, or would wrongly accept a re-versioned
// document. Both failure modes are asserted below.

import { readTelemetry, type Telemetry } from "@ceralive/srtla-send/telemetry";

// Each test gets a unique stats path so a parallel run never reads a sibling's
// file; everything lives under /tmp (Rule D — never escapes the repo root) and
// is removed in afterEach.
const writtenFiles = new Set<string>();
let counter = 0;

function statsPath(tag: string): string {
	const path = `/tmp/ceralive-rust-sender-skew-${process.pid}-${counter++}-${tag}.json`;
	writtenFiles.add(path);
	return path;
}

/** Write a raw document body to a fresh stats path and return that path. */
async function writeStats(tag: string, body: string): Promise<string> {
	const path = statsPath(tag);
	await Bun.write(path, body);
	return path;
}

/**
 * The canonical ADR-001 document the Rust sender emits for a single active
 * uplink under live streaming: schema_version 1, a non-zero Kalman rtt_ms, and a
 * bitrate_bps that already has the ×8 bytes/s → bits/s conversion applied.
 */
function rustSenderStreamingDoc(): string {
	// 312_500 wire bytes/s × 8 = 2_500_000 bits/s — the producer's exact invariant.
	return JSON.stringify({
		schema_version: 1,
		last_updated_ms: Date.now(),
		connections: [
			{
				conn_id: "0",
				rtt_ms: 42, // Kalman-smoothed, non-zero under streaming
				nak_count: 3,
				weight_percent: 60,
				window: 8192,
				in_flight: 100,
				bitrate_bps: 2_500_000,
			},
			{
				conn_id: "1",
				rtt_ms: 137, // second uplink, higher Kalman RTT
				nak_count: 0,
				weight_percent: 40,
				window: 4096,
				in_flight: 40,
				bitrate_bps: 1_000_000,
			},
		],
	});
}

beforeEach(() => {
	writtenFiles.clear();
});

afterEach(async () => {
	for (const path of writtenFiles) {
		await Bun.file(path)
			.delete()
			.catch(() => {});
	}
	writtenFiles.clear();
});

describe("rust-sender telemetry skew — valid producer document", () => {
	test("parses the Rust sender stats: schema_version=1, non-zero Kalman rtt_ms, bitrate_bps present", async () => {
		const path = await writeStats("streaming", rustSenderStreamingDoc());

		const snapshot = await readTelemetry(path);

		// A missing/mismatched reader would return null here; a non-zero Kalman
		// rtt_ms must round-trip from producer to consumer across the cutover.
		expect(snapshot).not.toBeNull();
		const tele = snapshot as Telemetry;

		// schema_version is the additive tag the Rust producer stamps; the reader
		// validates it as the literal 1 rather than silently stripping it.
		expect(tele.schema_version).toBe(1);

		expect(tele.connections).toHaveLength(2);

		const first = tele.connections[0];
		expect(first).toBeDefined();
		// Kalman-smoothed RTT must be present and non-zero under streaming — the
		// whole point of the skew test.
		expect(first?.rtt_ms).toBe(42);
		expect(first?.rtt_ms).toBeGreaterThan(0);
		// bitrate_bps must be present, numeric, and carry the ×8 conversion.
		expect(typeof first?.bitrate_bps).toBe("number");
		expect(first?.bitrate_bps).toBe(2_500_000);
		expect(first?.bitrate_bps).toBe(312_500 * 8);

		// The frozen contract's window/in_flight pair must survive the read.
		expect(first?.window).toBe(8192);
		expect(first?.in_flight).toBe(100);

		// The second uplink's higher Kalman RTT must also be preserved verbatim.
		expect(tele.connections[1]?.rtt_ms).toBe(137);
		expect(tele.connections[1]?.bitrate_bps).toBe(1_000_000);
	});

	test("idle-but-running snapshot (connections: []) is a valid schema_version=1 document, not null", async () => {
		const path = await writeStats(
			"idle",
			JSON.stringify({
				schema_version: 1,
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);

		const snapshot = await readTelemetry(path);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.schema_version).toBe(1);
		expect(snapshot?.connections).toEqual([]);
	});

	test("an old-but-valid snapshot still parses (readTelemetry does not fold in staleness)", async () => {
		const path = await writeStats(
			"old",
			JSON.stringify({
				schema_version: 1,
				last_updated_ms: 1, // ancient, but a structurally valid document
				connections: [
					{
						conn_id: "0",
						rtt_ms: 80,
						nak_count: 0,
						weight_percent: 100,
						window: 2048,
						in_flight: 10,
						bitrate_bps: 500_000,
					},
				],
			}),
		);

		const snapshot = await readTelemetry(path);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.connections[0]?.rtt_ms).toBe(80);
	});
});

describe("rust-sender telemetry skew — version mismatch is rejected loudly", () => {
	// These are the "mismatched reader" guards: a reader that ignored
	// schema_version would wrongly accept a re-versioned document and silently
	// misread it. The strict reader must return null instead.

	test("a future schema_version (2) is refused → null", async () => {
		const path = await writeStats(
			"v2",
			JSON.stringify({
				schema_version: 2,
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);
		expect(await readTelemetry(path)).toBeNull();
	});

	test("a missing schema_version is refused → null", async () => {
		const path = await writeStats(
			"noversion",
			JSON.stringify({
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);
		expect(await readTelemetry(path)).toBeNull();
	});

	test('schema_version as the string "1" is refused → null', async () => {
		const path = await writeStats(
			"strversion",
			JSON.stringify({
				schema_version: "1",
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);
		expect(await readTelemetry(path)).toBeNull();
	});
});

describe("rust-sender telemetry skew — required fields enforced", () => {
	test("a connection missing rtt_ms is refused → null", async () => {
		const path = await writeStats(
			"no-rtt",
			JSON.stringify({
				schema_version: 1,
				last_updated_ms: Date.now(),
				connections: [
					{
						conn_id: "0",
						nak_count: 0,
						weight_percent: 100,
						window: 2048,
						in_flight: 10,
						bitrate_bps: 500_000,
					},
				],
			}),
		);
		expect(await readTelemetry(path)).toBeNull();
	});

	test("a connection missing bitrate_bps is refused → null", async () => {
		const path = await writeStats(
			"no-bitrate",
			JSON.stringify({
				schema_version: 1,
				last_updated_ms: Date.now(),
				connections: [
					{
						conn_id: "0",
						rtt_ms: 42,
						nak_count: 0,
						weight_percent: 100,
						window: 2048,
						in_flight: 10,
					},
				],
			}),
		);
		expect(await readTelemetry(path)).toBeNull();
	});
});

describe("rust-sender telemetry skew — malformed input degrades gracefully", () => {
	// The backend must never crash on a bad stats file; the reader returns null.

	test("truncated JSON → null (no throw)", async () => {
		const path = await writeStats(
			"truncated",
			'{"schema_version":1,"last_updated_ms":123,"connections":[{"conn_id":"0","rtt_ms":4',
		);
		expect(await readTelemetry(path)).toBeNull();
	});

	test("non-JSON garbage → null (no throw)", async () => {
		const path = await writeStats("garbage", "{ this is not valid json ::::");
		expect(await readTelemetry(path)).toBeNull();
	});

	test("empty file → null (no throw)", async () => {
		const path = await writeStats("empty", "");
		expect(await readTelemetry(path)).toBeNull();
	});

	test("a JSON array (not an object) → null (no throw)", async () => {
		const path = await writeStats("array", "[]");
		expect(await readTelemetry(path)).toBeNull();
	});

	test("an absent file → null (no throw)", async () => {
		// Reserve a path but never write it.
		const path = `/tmp/ceralive-rust-sender-skew-absent-${process.pid}-${counter++}.json`;
		expect(await readTelemetry(path)).toBeNull();
	});
});
