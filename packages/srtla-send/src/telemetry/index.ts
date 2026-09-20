import { z } from "zod";

/**
 * Sender telemetry reader for the `srtla` sender (ADR-001, Option A — JSON stats file).
 *
 * The Rust sender (`src/telemetry_file.rs`) publishes a per-uplink snapshot to a
 * stats file via atomic `rename(2)` when started with `--stats-file`. This module
 * is the Bun-native consumer side: it reads that file with `Bun.file()` and
 * validates it against the frozen ADR-001 schema.
 *
 * Absorbed verbatim from the retired npm sender binding (plan
 * upstream-rebase-hard-fork, D13). Export NAMES are unchanged: `readTelemetry`,
 * `watchTelemetry`, `senderTelemetryPath`, `telemetrySchema`,
 * `connectionTelemetrySchema`, `SENDER_TELEMETRY_STALE_MS`,
 * `SENDER_TELEMETRY_PATH_PREFIX`.
 *
 * FIELD ORDER IS LOAD-BEARING. The schema declares its keys in the Rust
 * producer's own emission order, which is what makes a parsed-then-reserialized
 * document byte-identical to the producer's bytes. `tests/telemetry-roundtrip.
 * test.ts` asserts exactly that; reordering the object literals below breaks it,
 * and that alarm is the point — fix the order, never relax the assertion.
 */

/**
 * Snapshot age (now − `last_updated_ms`) past which the snapshot is no longer
 * live. Fixed by ADR-001 and matched to the Rust producer's
 * `SENDER_TELEMETRY_STALE_MS`. {@link watchTelemetry} surfaces this as a `stale`
 * flag; {@link readTelemetry} returns the parsed snapshot regardless of age so the
 * caller decides what to do with an old-but-valid document.
 */
export const SENDER_TELEMETRY_STALE_MS = 5000;

/**
 * Well-known path prefix, mirroring the producer's stats-file convention. The
 * live file is `<prefix><listen_port>.json`.
 */
export const SENDER_TELEMETRY_PATH_PREFIX = "/tmp/srtla-send-stats-";

/** Default live stats path for a listen port (the Rust producer computes the same). */
export function senderTelemetryPath(listenPort: number): string {
	return `${SENDER_TELEMETRY_PATH_PREFIX}${listenPort}.json`;
}

/**
 * One per-connection record. Field names/units mirror the Rust producer's
 * serialized `ConnRecord` (`src/telemetry_file.rs`). `window` and `in_flight` are
 * REQUIRED — they are part of the frozen telemetry contract and must never be
 * dropped from this schema.
 */
export const connectionTelemetrySchema = z.object({
	/** 0-based uplink index in IP-list order, stringified (stable until SIGHUP reorder). */
	conn_id: z.string(),
	/** Kalman-smoothed round-trip time, milliseconds. */
	rtt_ms: z.number().int().min(0),
	/** Cumulative NAKs attributed to this uplink. */
	nak_count: z.number().int().min(0),
	/** This link's normalized share of selection weight, 0–100. */
	weight_percent: z.number().int().min(0).max(100),
	/** Congestion-window size (required by the frozen contract). */
	window: z.number().int(),
	/** In-flight (sent-but-unacknowledged) packet count (required by the frozen contract). */
	in_flight: z.number().int(),
	/**
	 * Send rate in **bits per second**.
	 *
	 * INVARIANT: `bitrate_bps = wire_bytes_per_sec × 8`. The producer applies the
	 * mandated ×8 bytes/s → bits/s conversion exactly once, at JSON serialization
	 * (`src/telemetry_file.rs::build_telemetry_json`); the raw wire-bytes/s value
	 * never appears on the wire. Consumers must treat this field as bits/s.
	 */
	bitrate_bps: z.number().int().min(0),
	/**
	 * Cumulative wire **BYTES** this uplink has sent this session (ADR-002).
	 *
	 * Not bits and not a rate — deliberately unlike the `bitrate_bps` field
	 * directly above it, which is bits/s. No ×8 is applied to this value.
	 *
	 * Monotonic for the sender process's lifetime: it does NOT reset when the
	 * link's socket is replaced on a transient reconnect. It restarts at 0 only
	 * when `srtla_send` itself restarts, i.e. on a genuinely new stream.
	 *
	 * OPTIONAL: a producer predating ADR-002 omits it. Absent means UNKNOWN,
	 * never zero.
	 */
	bytes_sent_total: z.number().int().min(0).optional(),
	/**
	 * Egress interface this uplink's socket is bound to (`SO_BINDTODEVICE`).
	 *
	 * OPTIONAL: absent for an unmapped (legacy source-IP-bound) link and for any
	 * producer predating ADR-003. Absent means UNKNOWN, never "none".
	 */
	iface: z.string().min(1).optional(),
	/**
	 * The bind-map sidecar's writer-assigned opaque link identity (ADR-003),
	 * echoed verbatim by the sender — which never invents one.
	 *
	 * **This is the identity a UI must key on.** Unlike `conn_id`, it survives a
	 * SIGHUP reload, a reorder of the IP list, a reconnect, a DHCP lease change,
	 * and a move to a different interface. Two twin modems that share one source
	 * IP are distinguishable ONLY by this field.
	 *
	 * OPTIONAL: absent for an unmapped link and for any producer predating
	 * ADR-003.
	 */
	link_id: z.string().min(1).optional(),
});

/**
 * Why a configured bind-map is not in force (ADR-003 §6.4). Exactly seven
 * values; the set is frozen.
 */
export const bindMapDegradedReasonSchema = z.enum([
	"hash_mismatch",
	"malformed",
	"unknown_iface",
	"retry_exhausted",
	"missing_file",
	"unreadable",
	"unsupported",
]);

/**
 * Is the sender's bind-map in force? `reason` is present only when `state` is
 * `degraded`.
 */
export const bindMapStatusSchema = z.object({
	state: z.enum(["active", "absent", "degraded"]),
	reason: bindMapDegradedReasonSchema.optional(),
});

/**
 * One same-IP group a degraded startup could not disambiguate.
 *
 * The indices are **`BIND_IPS_FILE` line positions**, not `conn_id`s: an
 * excluded line never becomes a connection, so the two numberings diverge
 * exactly when this array is non-empty.
 */
export const bindMapCollisionSchema = z.object({
	ip: z.string().min(1),
	effective_index: z.number().int().min(0),
	excluded_indices: z.array(z.number().int().min(0)),
});

/**
 * What the sender is ACTUALLY running (ADR-003 §6.4) — orthogonal to
 * {@link bindMapStatusSchema}, because a degraded map can still leave a bond
 * interface-pinned (`retained_last_valid`) or leave modems dark
 * (`startup_collision_excluded`). `collisions` is present only for the latter.
 */
export const bindMapDispositionSchema = z.object({
	state: z.enum([
		"mapped",
		"retained_last_valid",
		"legacy_unique_only",
		"startup_collision_excluded",
	]),
	collisions: z.array(bindMapCollisionSchema).optional(),
});

/**
 * One snapshot object (never NDJSON — the file holds exactly one object).
 *
 * `schema_version` is validated as the literal `1`: a future producer bump fails
 * the parse loudly (`readTelemetry` → `null`) rather than being silently stripped,
 * so a consumer can never misread a re-versioned document as valid.
 */
export const telemetrySchema = z.object({
	schema_version: z.literal(1),
	last_updated_ms: z.number().int().min(0),
	connections: z.array(connectionTelemetrySchema),
	/**
	 * Cumulative wire **BYTES** the whole bond has sent this session (ADR-002).
	 *
	 * This is the authoritative "total data transferred" figure. It is a session
	 * accumulator, NOT the sum of `connections[].bytes_sent_total`: a link torn
	 * down by a SIGHUP IP-list reload leaves the `connections` array but its
	 * bytes stay banked here, so this value never regresses. Summing the live
	 * links instead would make an operator's total jump backwards.
	 *
	 * Resets to 0 only when the `srtla_send` process restarts — i.e. on a new
	 * stream, and NOT on a per-link reconnect.
	 *
	 * OPTIONAL: a producer predating ADR-002 omits it. Absent means UNKNOWN,
	 * never zero.
	 */
	bytes_sent_total: z.number().int().min(0).optional(),
	/**
	 * The sender's bind-map status (ADR-003 §6.4).
	 *
	 * OPTIONAL: a producer predating ADR-003 omits it. Absent means UNKNOWN —
	 * NOT `absent`, which is the positive statement "this sender was started
	 * without `--bind-map`".
	 */
	bind_map_status: bindMapStatusSchema.optional(),
	/**
	 * What the sender is actually running (ADR-003 §6.4).
	 *
	 * OPTIONAL: a producer predating ADR-003 omits it. Absent means UNKNOWN.
	 */
	disposition: bindMapDispositionSchema.optional(),
});

export type ConnectionTelemetry = z.output<typeof connectionTelemetrySchema>;
export type Telemetry = z.output<typeof telemetrySchema>;
export type BindMapDegradedReason = z.output<
	typeof bindMapDegradedReasonSchema
>;
export type BindMapStatus = z.output<typeof bindMapStatusSchema>;
export type BindMapCollision = z.output<typeof bindMapCollisionSchema>;
export type BindMapDisposition = z.output<typeof bindMapDispositionSchema>;

/**
 * Read and validate the sender telemetry snapshot at `path`.
 *
 * Returns `null` (never throws) when the file is absent, unparseable, or fails
 * schema validation — including a `schema_version` mismatch. A schema-valid
 * snapshot is returned as a typed {@link Telemetry} object regardless of age; the
 * "running but idle" `connections: []` case is a valid snapshot, not `null`.
 * Staleness is intentionally NOT folded into this result — see
 * {@link watchTelemetry}, which reports it as a separate `stale` flag.
 *
 * All I/O is Bun-native (`Bun.file`); no Node filesystem or process plumbing.
 */
export async function readTelemetry(path: string): Promise<Telemetry | null> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}
		const parsed = telemetrySchema.safeParse(JSON.parse(await file.text()));
		return parsed.success ? parsed.data : null;
	} catch {
		// Malformed/truncated read (atomic rename should prevent it, but guard
		// defensively) — telemetry is best-effort, never fatal.
		return null;
	}
}

export {
	type TelemetryUpdate,
	type WatchTelemetryHandle,
	type WatchTelemetryOptions,
	watchTelemetry,
} from "./watch";
