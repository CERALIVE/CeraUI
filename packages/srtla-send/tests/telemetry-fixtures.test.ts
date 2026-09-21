import { describe, expect, test } from "bun:test";

import {
	readTelemetry,
	type Telemetry,
	telemetrySchema,
} from "../src/telemetry/index";

/**
 * The consumer half of the cross-language fixture matrix.
 *
 * Every file read here was WRITTEN BY THE RUST PRODUCER (`tests/telemetry_fixtures.rs`,
 * regenerated with `UPDATE_GOLDEN=1`) and is asserted byte-identical to this
 * package's copy by `tests/telemetry_fixture_parity.rs`. So these tests parse the
 * exact bytes the sender emits, not a hand-written approximation of them.
 *
 * Fixtures live beside the tests inside this package (Rule D — nothing resolves
 * above the repo root, no sibling checkout).
 */
const fixturePath = (name: string): string =>
	`${import.meta.dir}/fixtures/${name}.json`;

async function read(name: string): Promise<Telemetry> {
	const parsed = await readTelemetry(fixturePath(name));
	expect(parsed, `${name} must parse`).not.toBeNull();
	// biome-ignore lint/style/noNonNullAssertion: the expect above is the guard.
	return parsed!;
}

describe("old producer, new consumer", () => {
	test("a pre-ADR-003 document parses with every added field undefined", async () => {
		// Given: the byte-exact document the shipped 3.2.0 producer wrote, which
		// predates all four fields this schema gained.
		const snapshot = await read("telemetry-legacy-producer");

		// Then: it is still a fully valid snapshot — additive means the old
		// producer keeps working — and the new fields read as UNKNOWN rather
		// than as a fabricated default.
		expect(snapshot.schema_version).toBe(1);
		expect(snapshot.connections).toHaveLength(2);
		expect(snapshot.bind_map_status).toBeUndefined();
		expect(snapshot.disposition).toBeUndefined();
		expect(snapshot.connections[0]?.iface).toBeUndefined();
		expect(snapshot.connections[0]?.link_id).toBeUndefined();
	});

	test("the legacy document is not silently upgraded to a bind-map state", async () => {
		// `undefined` and `'absent'` are DIFFERENT answers: the first means the
		// producer never told us, the second is a positive statement that the
		// sender was started without --bind-map. Conflating them would make a UI
		// claim knowledge it does not have.
		const legacy = await read("telemetry-legacy-producer");
		const current = await read("telemetry-golden");

		expect(legacy.bind_map_status).toBeUndefined();
		expect(current.bind_map_status?.state).toBe("absent");
	});
});

describe("new producer, current consumer", () => {
	test("an unmapped run reports absent + legacy_unique_only", async () => {
		const snapshot = await read("telemetry-golden");

		expect(snapshot.bind_map_status).toEqual({ state: "absent" });
		expect(snapshot.disposition?.state).toBe("legacy_unique_only");
		expect(snapshot.disposition?.collisions).toBeUndefined();
		// An unmapped link genuinely has no identity to echo.
		expect(snapshot.connections[0]?.link_id).toBeUndefined();
	});

	test("twin modems sharing one source IP arrive as two identified links", async () => {
		// Given: the case legacy source-IP identity collapsed into a single link.
		const snapshot = await read("telemetry-mapped");

		// Then: both are present, each with its own writer-assigned identity and
		// its own interface — which is the whole point of the bind-map.
		expect(snapshot.connections).toHaveLength(2);
		expect(snapshot.connections.map((c) => c.link_id)).toEqual([
			"modem-a",
			"modem-b",
		]);
		expect(snapshot.connections.map((c) => c.iface)).toEqual([
			"wwan0",
			"wwan1",
		]);
		expect(snapshot.bind_map_status?.state).toBe("active");
		expect(snapshot.disposition?.state).toBe("mapped");
	});
});

describe("identity survives what conn_id does not", () => {
	test("a SIGHUP reorder moves conn_id but not link_id", async () => {
		const before = await read("telemetry-mapped");
		const after = await read("telemetry-reordered");

		// conn_id is positional, so slot 0 now names the OTHER modem.
		expect(before.connections[0]?.conn_id).toBe("0");
		expect(after.connections[0]?.conn_id).toBe("0");
		expect(after.connections[0]?.link_id).not.toBe(
			before.connections[0]?.link_id,
		);

		// A consumer keyed on link_id sees the same two links, merely reordered.
		expect([...(after.connections.map((c) => c.link_id) ?? [])].sort()).toEqual(
			[...(before.connections.map((c) => c.link_id) ?? [])].sort(),
		);
		// And each identity still carries the interface it had before.
		const ifaceOf = (s: Telemetry, id: string): string | undefined =>
			s.connections.find((c) => c.link_id === id)?.iface;
		expect(ifaceOf(after, "modem-a")).toBe(ifaceOf(before, "modem-a"));
		expect(ifaceOf(after, "modem-b")).toBe(ifaceOf(before, "modem-b"));
	});

	test("a reconnect onto a new interface keeps the identity and the byte count", async () => {
		const before = await read("telemetry-mapped");
		const after = await read("telemetry-reconnect");

		const wasA = before.connections.find((c) => c.link_id === "modem-a");
		const nowA = after.connections.find((c) => c.link_id === "modem-a");

		expect(nowA).toBeDefined();
		expect(nowA?.iface).not.toBe(wasA?.iface);
		// ADR-002: the socket was replaced, the session accumulator was not.
		expect(nowA?.bytes_sent_total ?? 0).toBeGreaterThan(
			wasA?.bytes_sent_total ?? 0,
		);
	});
});

describe("degraded operating modes are renderable from typed data alone", () => {
	test("a degraded startup names the colliding IP and the excluded lines", async () => {
		const snapshot = await read("telemetry-degraded-startup");

		expect(snapshot.bind_map_status).toEqual({
			state: "degraded",
			reason: "retry_exhausted",
		});
		expect(snapshot.disposition?.state).toBe("startup_collision_excluded");
		expect(snapshot.disposition?.collisions).toEqual([
			{ ip: "192.168.8.100", effective_index: 0, excluded_indices: [1] },
		]);
		// One link runs while two were configured — the group above is the only
		// way a UI can explain the missing modem.
		expect(snapshot.connections).toHaveLength(1);
	});

	test("a degraded reload reports degraded AND still-pinned", async () => {
		const snapshot = await read("telemetry-degraded-reload");

		expect(snapshot.bind_map_status?.state).toBe("degraded");
		expect(snapshot.bind_map_status?.reason).toBe("hash_mismatch");
		// The distinguishing fact: the bond is still running the last valid
		// mapped pool, so the links keep their identities.
		expect(snapshot.disposition?.state).toBe("retained_last_valid");
		expect(snapshot.disposition?.collisions).toBeUndefined();
		expect(snapshot.connections.map((c) => c.link_id)).toEqual([
			"modem-a",
			"modem-b",
		]);
	});

	test("every degraded reason in the frozen set is accepted", () => {
		const reasons = [
			"hash_mismatch",
			"malformed",
			"unknown_iface",
			"retry_exhausted",
			"missing_file",
			"unreadable",
			"unsupported",
		];
		for (const reason of reasons) {
			const parsed = telemetrySchema.safeParse({
				schema_version: 1,
				last_updated_ms: 1,
				connections: [],
				bind_map_status: { state: "degraded", reason },
			});
			expect(parsed.success, `reason ${reason} must be accepted`).toBe(true);
		}
	});

	test("a reason outside the frozen set is rejected", () => {
		const parsed = telemetrySchema.safeParse({
			schema_version: 1,
			last_updated_ms: 1,
			connections: [],
			bind_map_status: { state: "degraded", reason: "made_up" },
		});
		expect(parsed.success).toBe(false);
	});
});

describe("forward tolerance", () => {
	test("a FUTURE producer's unknown fields do not break today's reader", async () => {
		// Given: a document carrying keys this build has never heard of, at the
		// document, connection, and nested-status levels.
		const snapshot = await read("telemetry-unknown-fields");

		// Then: it parses, and every field this build DOES know survives intact —
		// so an old consumer keeps working against a newer sender.
		expect(snapshot.schema_version).toBe(1);
		expect(snapshot.connections[0]?.link_id).toBe("modem-a");
		expect(snapshot.connections[0]?.bitrate_bps).toBe(2500000);
		expect(snapshot.bind_map_status?.state).toBe("active");

		// The unknown keys are stripped rather than surfaced, which is what keeps
		// the parsed type honest.
		expect(Object.hasOwn(snapshot, "future_top_level_field")).toBe(false);
	});

	test("an unknown top-level key alone is never a parse failure", () => {
		const parsed = telemetrySchema.safeParse({
			schema_version: 1,
			last_updated_ms: 1,
			connections: [],
			some_field_from_2027: { anything: [1, 2, 3] },
		});
		expect(parsed.success).toBe(true);
	});
});
