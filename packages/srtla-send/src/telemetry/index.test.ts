import { afterEach, describe, expect, test } from "bun:test";

import {
	readTelemetry,
	SENDER_TELEMETRY_PATH_PREFIX,
	senderTelemetryPath,
	telemetrySchema,
} from "./index";

const created: Array<string> = [];

function tmpPath(): string {
	const p = `/tmp/srtla-send-tel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	created.push(p);
	return p;
}

async function writeSnapshot(content: string): Promise<string> {
	const p = tmpPath();
	await Bun.write(p, content);
	return p;
}

afterEach(async () => {
	for (const p of created.splice(0)) {
		try {
			await Bun.file(p).delete?.();
		} catch {
			// best-effort cleanup
		}
	}
});

function freshSnapshot(): string {
	return JSON.stringify({
		schema_version: 1,
		last_updated_ms: Date.now(),
		connections: [
			{
				conn_id: "0",
				rtt_ms: 42,
				nak_count: 3,
				weight_percent: 85,
				window: 8192,
				in_flight: 100,
				bitrate_bps: 2500000,
			},
		],
	});
}

describe("telemetrySchema", () => {
	test("readTelemetry_valid_snapshot_parses", async () => {
		const p = await writeSnapshot(freshSnapshot());
		const t = await readTelemetry(p);

		expect(t).not.toBeNull();
		if (t === null) return;
		expect(t.schema_version).toBe(1);
		expect(typeof t.last_updated_ms).toBe("number");
		expect(t.connections).toHaveLength(1);
		const [c] = t.connections;
		if (c === undefined) return;
		expect(c.conn_id).toBe("0");
		expect(c.rtt_ms).toBe(42);
		expect(c.nak_count).toBe(3);
		expect(c.weight_percent).toBe(85);
		expect(c.window).toBe(8192);
		expect(c.in_flight).toBe(100);
		expect(c.bitrate_bps).toBe(2500000);
	});

	test("requires window and in_flight (frozen contract)", () => {
		const missingWindow = {
			schema_version: 1,
			last_updated_ms: Date.now(),
			connections: [
				{
					conn_id: "0",
					rtt_ms: 1,
					nak_count: 0,
					weight_percent: 100,
					in_flight: 0,
					bitrate_bps: 0,
				},
			],
		};
		expect(telemetrySchema.safeParse(missingWindow).success).toBe(false);

		const missingInFlight = {
			schema_version: 1,
			last_updated_ms: Date.now(),
			connections: [
				{
					conn_id: "0",
					rtt_ms: 1,
					nak_count: 0,
					weight_percent: 100,
					window: 0,
					bitrate_bps: 0,
				},
			],
		};
		expect(telemetrySchema.safeParse(missingInFlight).success).toBe(false);
	});
});

describe("readTelemetry", () => {
	test("readTelemetry_schema_version_2_rejected", async () => {
		const p = await writeSnapshot(
			JSON.stringify({
				schema_version: 2,
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);
		expect(await readTelemetry(p)).toBeNull();
	});

	test("readTelemetry_schema_version_2_rejected_even_with_valid_connections", async () => {
		// The version gate dominates: a structurally-valid connections array must
		// still be rejected when schema_version != 1 (fail-loud on a producer bump).
		const p = await writeSnapshot(
			JSON.stringify({
				schema_version: 2,
				last_updated_ms: Date.now(),
				connections: [
					{
						conn_id: "0",
						rtt_ms: 42,
						nak_count: 3,
						weight_percent: 85,
						window: 8192,
						in_flight: 100,
						bitrate_bps: 2500000,
					},
				],
			}),
		);
		expect(await readTelemetry(p)).toBeNull();
	});

	test("missing schema_version is rejected (no silent strip)", async () => {
		const p = await writeSnapshot(
			JSON.stringify({ last_updated_ms: Date.now(), connections: [] }),
		);
		expect(await readTelemetry(p)).toBeNull();
	});

	test("readTelemetry_absent_file_returns_null", async () => {
		const p = `/tmp/srtla-send-tel-absent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
		expect(await readTelemetry(p)).toBeNull();
	});

	test("invalid JSON returns null (no throw)", async () => {
		const p = await writeSnapshot("{ this is not json");
		expect(await readTelemetry(p)).toBeNull();
	});

	test("idle snapshot (connections: []) returns the object, not null", async () => {
		const p = await writeSnapshot(
			JSON.stringify({
				schema_version: 1,
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);
		const t = await readTelemetry(p);
		expect(t).not.toBeNull();
		expect(t?.connections).toEqual([]);
	});

	test("old-but-valid snapshot still parses (staleness is the watcher's concern)", async () => {
		const p = await writeSnapshot(
			JSON.stringify({
				schema_version: 1,
				last_updated_ms: Date.now() - 60000,
				connections: [],
			}),
		);
		expect(await readTelemetry(p)).not.toBeNull();
	});
});

describe("senderTelemetryPath", () => {
	test("builds the well-known path for a listen port", () => {
		expect(senderTelemetryPath(5000)).toBe(
			`${SENDER_TELEMETRY_PATH_PREFIX}5000.json`,
		);
		expect(senderTelemetryPath(9000)).toBe("/tmp/srtla-send-stats-9000.json");
	});
});

// Real Rust-producer output (Task 10) copied into this package's own fixtures so
// the test never reads above its repo root (Rule D). The reader must round-trip it.
const GOLDEN_FIXTURE_PATH = `${import.meta.dir}/../../tests/fixtures/telemetry-golden.json`;

describe("round-trip golden fixture (T21)", () => {
	test("round_trip_golden_fixture", async () => {
		const t = await readTelemetry(GOLDEN_FIXTURE_PATH);
		expect(t).not.toBeNull();
		if (t === null) return;

		expect(t.schema_version).toBe(1);
		expect(t.last_updated_ms).toBe(1749556546000);
		expect(t.connections).toEqual([
			{
				conn_id: "0",
				rtt_ms: 42,
				nak_count: 3,
				weight_percent: 85,
				window: 8192,
				in_flight: 100,
				bitrate_bps: 2500000,
				bytes_sent_total: 812000000,
			},
			{
				conn_id: "1",
				rtt_ms: 73,
				nak_count: 11,
				weight_percent: 55,
				window: 4096,
				in_flight: 240,
				bitrate_bps: 1200000,
				bytes_sent_total: 808000000,
			},
		]);
		expect(t.bytes_sent_total).toBe(1620000000);
	});

	test("bitrate_x8_invariant", async () => {
		// bitrate_bps = wire_bytes_per_sec × 8, applied exactly once by the producer.
		// conn0's 2_500_000 bps is 312_500 B/s × 8; assert the fixture carries the
		// post-conversion value, not the raw byte rate.
		const t = await readTelemetry(GOLDEN_FIXTURE_PATH);
		expect(t).not.toBeNull();
		if (t === null) return;
		expect(312500 * 8).toBe(2_500_000);
		expect(t.connections[0]?.bitrate_bps).toBe(2_500_000);
		// conn1: 150_000 B/s × 8 = 1_200_000 bps.
		expect(150000 * 8).toBe(1_200_000);
		expect(t.connections[1]?.bitrate_bps).toBe(1_200_000);
	});

	test("golden fixture is newline-free single object (atomic-publish shape)", async () => {
		const raw = await Bun.file(GOLDEN_FIXTURE_PATH).text();
		expect(raw.includes("\n")).toBe(false);
		expect(JSON.parse(raw)).toBeInstanceOf(Object);
	});
});

describe("schema edge cases (T21)", () => {
	test("schema_version_2_rejected", async () => {
		const p = await writeSnapshot(
			JSON.stringify({
				schema_version: 2,
				last_updated_ms: Date.now(),
				connections: [],
			}),
		);
		expect(await readTelemetry(p)).toBeNull();
		expect(
			telemetrySchema.safeParse({
				schema_version: 2,
				last_updated_ms: 0,
				connections: [],
			}).success,
		).toBe(false);
	});

	test("missing_required_field_rejected", async () => {
		const missingWindow = {
			schema_version: 1,
			last_updated_ms: Date.now(),
			connections: [
				{
					conn_id: "0",
					rtt_ms: 42,
					nak_count: 3,
					weight_percent: 85,
					in_flight: 100,
					bitrate_bps: 2500000,
				},
			],
		};
		expect(telemetrySchema.safeParse(missingWindow).success).toBe(false);
		const p = await writeSnapshot(JSON.stringify(missingWindow));
		expect(await readTelemetry(p)).toBeNull();
	});

	test("extra_fields_stripped_or_rejected", async () => {
		// Zod's default object semantics strip unknown keys: the parse succeeds and an
		// unrecognized per-connection field does not leak into the typed result.
		//
		// This test originally used `iface` as its stand-in for "a field a future
		// producer might add". `iface` has since BECOME a known optional field
		// (ADR-003), so the placeholder moved to a genuinely unknown key and the
		// now-known field is asserted to be PRESERVED — the same contract, read
		// from both sides.
		const withExtra = {
			schema_version: 1,
			last_updated_ms: Date.now(),
			connections: [
				{
					conn_id: "0",
					rtt_ms: 42,
					nak_count: 3,
					weight_percent: 85,
					window: 8192,
					in_flight: 100,
					bitrate_bps: 2500000,
					iface: "usb0",
					enrichment_from_a_later_producer: "usb0",
				},
			],
		};
		const parsed = telemetrySchema.safeParse(withExtra);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.connections[0]).not.toHaveProperty(
			"enrichment_from_a_later_producer",
		);
		expect(parsed.data.connections[0]?.iface).toBe("usb0");

		const p = await writeSnapshot(JSON.stringify(withExtra));
		const t = await readTelemetry(p);
		expect(t).not.toBeNull();
		expect(t?.connections[0]).not.toHaveProperty(
			"enrichment_from_a_later_producer",
		);
		expect(t?.connections[0]?.iface).toBe("usb0");
	});
});
