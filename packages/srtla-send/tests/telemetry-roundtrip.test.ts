import { describe, expect, test } from "bun:test";

import {
	readTelemetry,
	type Telemetry,
	telemetrySchema,
} from "../src/telemetry/index";

/**
 * Byte-parity round-trip: `parse(serialize(x))` must preserve EVERY field the
 * Rust sender emits — including the two additive identity fields `iface` and
 * `link_id`.
 *
 * Why this exists as its own suite: a Zod object strips what its schema does not
 * declare, silently and successfully. A reader that has simply never heard of
 * `iface`/`link_id` therefore parses a mapped snapshot with no error at all and
 * hands the consumer a document with both modems' identities deleted — which is
 * exactly what the released 2026.6.2 npm binding's reader did, and
 * exactly the failure mode a "does it parse?" test cannot see.
 *
 * Re-serializing the parsed document and comparing it to the producer's original
 * bytes DOES see it: a dropped field changes the bytes. The fixtures read here
 * are written by the Rust producer (`tests/telemetry_fixtures.rs`) and asserted
 * byte-identical to this package's copies by `tests/telemetry_fixture_parity.rs`,
 * so the comparison is against the sender's real output, not a transcription of
 * it. `falsifies the byte-parity assertion` below proves the check discriminates.
 *
 * The schema declares its keys in the producer's own field order, so a
 * round-tripped document is byte-identical rather than merely equivalent.
 */
const fixturePath = (name: string): string =>
	`${import.meta.dir}/fixtures/${name}.json`;

const readBytes = (name: string): Promise<string> =>
	Bun.file(fixturePath(name)).text();

/** One full `parse(serialize(parse(bytes)))` cycle. */
function roundTrip(bytes: string): {
	once: Telemetry;
	serialized: string;
	twice: Telemetry;
} {
	const once = telemetrySchema.parse(JSON.parse(bytes));
	const serialized = JSON.stringify(once);
	const twice = telemetrySchema.parse(JSON.parse(serialized));
	return { once, serialized, twice };
}

/**
 * Every fixture the producer writes in its own field order. `telemetry-unknown-
 * fields` is deliberately excluded: it is hand-ordered and carries keys from a
 * hypothetical future producer, so its bytes cannot survive today's schema by
 * construction — it gets a semantic round-trip assertion instead, below.
 */
const PRODUCER_ORDERED_FIXTURES: string[] = [
	"telemetry-golden",
	"telemetry-legacy-producer",
	"telemetry-mapped",
	"telemetry-reordered",
	"telemetry-reconnect",
	"telemetry-degraded-startup",
	"telemetry-degraded-reload",
];

describe("byte parity: parse(serialize(x)) preserves every sender field", () => {
	test.each(PRODUCER_ORDERED_FIXTURES)(
		"%s survives the round trip byte-for-byte",
		async (name) => {
			const bytes = await readBytes(name);

			const { serialized, twice } = roundTrip(bytes);

			// Nothing added, nothing dropped, nothing reordered.
			expect(serialized).toBe(bytes);
			// And the cycle is stable: a second pass is a fixed point.
			expect(JSON.stringify(twice)).toBe(bytes);
		},
	);

	test("the mapped twins keep iface and link_id through two full cycles", async () => {
		// Given: the one case legacy source-IP identity collapses — two modems on
		// ONE source address, distinguishable only by the additive fields.
		const bytes = await readBytes("telemetry-mapped");

		const { once, twice, serialized } = roundTrip(bytes);

		for (const snapshot of [once, twice]) {
			expect(snapshot.connections.map((c) => c.iface)).toEqual([
				"wwan0",
				"wwan1",
			]);
			expect(snapshot.connections.map((c) => c.link_id)).toEqual([
				"modem-a",
				"modem-b",
			]);
		}
		// The serialized form still names both, so a downstream consumer reading
		// the re-emitted bytes is told what the sender said.
		expect(serialized).toContain('"iface":"wwan0"');
		expect(serialized).toContain('"link_id":"modem-b"');
		// schema_version is NOT bumped by carrying the additive fields (ADR-001).
		expect(twice.schema_version).toBe(1);
	});

	test("a typed object round-trips to itself with the identity fields intact", () => {
		// The `parse(serialize(x))` direction starting from a TS-side value rather
		// than from producer bytes: whatever a caller holds is what a caller gets
		// back, so the binding is a passthrough in both directions.
		const x: Telemetry = {
			schema_version: 1,
			last_updated_ms: 1749556546000,
			connections: [
				{
					conn_id: "0",
					rtt_ms: 42,
					nak_count: 3,
					weight_percent: 50,
					window: 8192,
					in_flight: 100,
					bitrate_bps: 2500000,
					bytes_sent_total: 812000000,
					iface: "wwan0",
					link_id: "modem-a",
				},
			],
			bytes_sent_total: 1620000000,
			bind_map_status: { state: "active" },
			disposition: { state: "mapped" },
		};

		expect(telemetrySchema.parse(JSON.parse(JSON.stringify(x)))).toEqual(x);
	});

	test("a stripped identity field falsifies the byte-parity assertion", async () => {
		// The control. Without it, `serialized === bytes` proves nothing — it could
		// hold for a reader that drops the fields if the producer never emitted
		// them. Deleting exactly what a stripping parser would delete must break
		// the comparison, and does.
		const bytes = await readBytes("telemetry-mapped");
		const stripped = telemetrySchema.parse(JSON.parse(bytes));
		for (const conn of stripped.connections) {
			delete conn.iface;
			delete conn.link_id;
		}

		expect(JSON.stringify(stripped)).not.toBe(bytes);
	});

	test("a future producer's document round-trips to a stable known subset", async () => {
		// Unknown keys are stripped by design, so byte parity cannot hold here.
		// What must hold is idempotence — one pass reaches the fixed point, so a
		// consumer that re-emits a parsed document never loses more on the second
		// pass than it did on the first — with the known additive fields kept.
		const bytes = await readBytes("telemetry-unknown-fields");

		const { once, serialized, twice } = roundTrip(bytes);

		expect(twice).toEqual(once);
		expect(JSON.stringify(twice)).toBe(serialized);
		expect(once.connections[0]?.iface).toBe("wwan0");
		expect(once.connections[0]?.link_id).toBe("modem-a");
	});
});

describe("a 2026.6.2-era payload without the additive fields", () => {
	/**
	 * The shape the sender emitted before it echoed identity, and the shape an
	 * older sender on a not-yet-updated device still emits today. It must remain
	 * a first-class valid document: absent is UNKNOWN, never an error and never a
	 * fabricated default.
	 */
	const legacyPayload = {
		schema_version: 1,
		last_updated_ms: 1749556546000,
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
	};

	test("parses without throwing, with iface and link_id undefined", () => {
		const parsed = telemetrySchema.safeParse(legacyPayload);

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.connections[0]?.iface).toBeUndefined();
		expect(parsed.data.connections[0]?.link_id).toBeUndefined();
		// The top-level ADR-003 pair is equally optional, and equally UNKNOWN —
		// not the positive `absent` state a newer sender would report.
		expect(parsed.data.bind_map_status).toBeUndefined();
		expect(parsed.data.disposition).toBeUndefined();
	});

	test("round-trips without the reader inventing the absent fields", () => {
		const bytes = JSON.stringify(legacyPayload);

		const { serialized, twice } = roundTrip(bytes);

		// No `"iface":null`, no `"link_id":""`, no key at all — an omitted optional
		// stays omitted, which is what keeps "absent" distinguishable from "empty".
		expect(serialized).toBe(bytes);
		expect(Object.hasOwn(twice.connections[0] ?? {}, "iface")).toBe(false);
		expect(Object.hasOwn(twice.connections[0] ?? {}, "link_id")).toBe(false);
	});

	test("readTelemetry returns the snapshot rather than null for the old shape", async () => {
		// The frozen byte-exact document the pre-identity producer wrote, read
		// through the real file reader — the path CeraUI actually takes.
		const snapshot = await readTelemetry(
			fixturePath("telemetry-legacy-producer"),
		);

		expect(snapshot).not.toBeNull();
		expect(snapshot?.connections).toHaveLength(2);
		expect(snapshot?.connections.every((c) => c.iface === undefined)).toBe(
			true,
		);
		expect(snapshot?.connections.every((c) => c.link_id === undefined)).toBe(
			true,
		);
	});
});
