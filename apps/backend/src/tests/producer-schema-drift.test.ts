/// <reference types="bun" />
/// <reference lib="es2022" />

import { describe, expect, test } from "bun:test";

// PRODUCER SCHEMA-DRIFT CONTRACT GATE
//
// Zod's `z.object()` SILENTLY STRIPS unrecognized keys on `.parse()`. So a
// consumer pinned to an OLD binding whose schema does not know a NEW producer
// field drops that field before any business logic sees it — no error, no
// warning, and a PASSING typecheck whenever the consumer declared its own local
// shape for the same wire data. It is a runtime-only, silent data loss.
//
// The motivating case is recorded verbatim in the workspace root AGENTS.md:
// cerastream PR #126 added `device_address` to `captureDeviceSchema`, and CeraUI
// PR #303 merged the same day shipping BT-mic code reading `node.device_address`
// while still pinned to `@ceralive/cerastream@2026.8.0`, whose gitHead predates
// PR #126 entirely. Three CeraUI modules each declared a LOCAL
// `device_address?: string`, so `tsc` never saw the mismatch and the field was
// Zod-stripped on every real device.
//
// THIS TEST IS THE ENFORCEMENT of the root "publish before consume" gate. It
// takes ONE manifest of the producer wire-field paths CeraUI actually reads and
// asserts, against the schemas ACTUALLY INSTALLED in node_modules, that every
// one of them exists. A stale pin plus new-field usage therefore fails CI rather
// than a device.
//
// WHAT THIS IS NOT:
//
//   - It is NOT a version assertion. Nothing here names a producer version, and
//     nothing may: the test must pass against ANY pin that carries the fields in
//     the manifest, so a bump that is additive-only stays green with no edit.
//     Version/export-surface skew is a DIFFERENT axis, already guarded by
//     `cerastream-bindings-skew.test.ts`, `srtla-send-bindings-skew.test.ts`,
//     `modem-control-skew-matrix.test.ts` and
//     `remote-control/protocol.export-surface.test.ts`. This one guards the
//     inside of the schemas those tests guard the names of.
//
//   - It is NOT an inventory of every producer field. It carries only fields
//     CeraUI READS off producer-typed wire data. A field CeraUI merely forwards
//     verbatim is not read and is not listed.
//
//   - It deliberately omits fields CeraUI only EMITS through a producer type
//     (e.g. `SrtlaSendOptions`, the `device.hello` `deviceCaps` block). Those are
//     ordinary typed function arguments / object literals, so `tsc` already
//     fails on a rename — the silent-strip hazard this test exists for is
//     specific to INBOUND data crossing a `.parse()`.
//
// PATH GRAMMAR: a manifest entry is a dot path resolved against the schema's
// shape. Array, record, set, map, optional, nullable, default, readonly, catch,
// lazy and pipe wrappers are transparently unwrapped, so `caps.width` means
// "`caps` is an (optional) array of objects carrying `width`". A union resolves
// when ANY arm resolves the remaining path.

import * as cerastream from "@ceralive/cerastream";
import * as controlProtocol from "@ceralive/control-protocol";
import * as modemControl from "@ceralive/modem-control";
import * as srtlaSend from "@ceralive/srtla-send";

// ---------------------------------------------------------------------------
// THE MANIFEST — producer wire fields CeraUI reads, grouped by producer schema.
//
// Every entry below was established by scanning `apps/backend/src` for the read
// site, not by reading the producer's schema. Adding a field here without a
// consumer is not harmless: it turns an unused producer field into a merge
// blocker for a producer that legitimately retires it.
// ---------------------------------------------------------------------------

type SchemaManifest = Readonly<Record<string, readonly string[]>>;

/** `@ceralive/cerastream` — the streaming engine's IPC wire. */
const CERASTREAM_FIELDS: SchemaManifest = {
	// `probeEngineDevices` (sources.ts) copies these off `list-devices` through a
	// hand-maintained whitelist; an unlisted field never reaches the wire at all.
	captureDeviceSchema: [
		"input_id",
		"device_path",
		"display_name",
		"media_class",
		"kind",
		"caps",
		"modes",
		"stable_id",
		"physical_group_id",
		"alsa_card_id",
		"product_name",
		"transport",
		// The PR #126 field the root case study is about.
		"device_address",
	],
	captureCapSchema: ["width", "height", "framerate", "media_type"],
	captureModeSchema: ["media_type", "pipeline_kind", "caps"],
	videoSourceCapSchema: [
		"id",
		"supports_audio",
		"supports_resolution_override",
		"supports_framerate_override",
		"default_resolution",
		"default_framerate",
	],
	// `hardware_kind` is read by the raw-IPC probe in system/hardware-kind.ts;
	// the other three are the key set `cerastream-wire-skew.ts` S3 pins.
	platformCapsSchema: [
		"supports_h265",
		"hardware_accelerated",
		"max_resolution",
		"hardware_kind",
	],
	encoderCapsSchema: ["bitrate_range"],
	encoderCapabilitySchema: [
		"codec",
		"max_resolution",
		"max_framerate",
		"formats",
		"gates.4k60",
		"gates.reason",
	],
	getCapabilitiesResultSchema: [
		"platform",
		"platform.hardware_kind",
		"encoder",
		"encoder.bitrate_range",
		"encoders",
		"encoders.codec",
		"encoders.max_resolution",
		"encoders.max_framerate",
		"encoders.formats",
		"encoders.gates.4k60",
		"encoders.gates.reason",
		"sources",
		"features",
		"preview.enabled",
		"preview.port",
		"preview.bound",
		"audio_backends.supported",
		"latency_range.min",
		"latency_range.max",
		"fec_capable",
		"supported_profiles",
		"profile_catalog_version",
		"network_embedded_audio",
	],
	listDevicesResultSchema: ["devices"],
	statusEventSchema: [
		"type",
		"state",
		"streaming",
		"active_input",
		"buffering",
		"spooled_bytes",
		"data_headroom_bytes",
		"disk_warning",
		"active_encode",
		"preview_encoder_realized",
	],
	activeEncodeSchema: [
		"codec",
		"resolution",
		"framerate",
		"active_input",
		"decoder",
		"input_codec",
		"passthrough",
		"frames_emitted",
		"pipeline_playing",
	],
	audioLevelEventSchema: [
		"type",
		"source",
		"channels",
		"rms_db",
		"peak_db",
		"floor_db",
		"unavailable",
		"reason",
	],
	audioConfigSchema: ["backend", "mode", "device", "codec", "delay_ms"],
	runtimeErrorEventSchema: ["type", "code", "source", "reason", "selected"],
	// Read through `CerastreamRpcError.captureCauses()[0]?.cause`.
	captureCauseEntrySchema: ["cause"],
	helloResultSchema: ["protocol", "schema_version", "engine_version"],
	changeConfigResultSchema: ["attempt_id", "phase", "reason"],
	configChangeEventSchema: ["attempt_id", "phase", "reason"],
	previewEncoderRealizedSchema: [
		"selected_element",
		"realized_element",
		"mode",
		"fallback_reason",
	],
	srtStatsEventSchema: ["rtt_ms", "send_buffer", "pkt_loss"],
	bitrateEventSchema: ["current_bitrate", "max_bitrate"],
};

/** `@ceralive/srtla-send` — the sender's telemetry + bind-map report. */
const SRTLA_SEND_FIELDS: SchemaManifest = {
	telemetrySchema: [
		"connections",
		"bytes_sent_total",
		"bind_map_status",
		"disposition",
	],
	connectionTelemetrySchema: [
		"conn_id",
		"rtt_ms",
		"nak_count",
		"weight_percent",
		"bitrate_bps",
		"bytes_sent_total",
		"iface",
		"link_id",
	],
	bindMapStatusSchema: ["state", "reason"],
	bindMapDispositionSchema: ["state", "collisions"],
	bindMapCollisionSchema: ["ip", "effective_index", "excluded_indices"],
};

/** `@ceralive/control-protocol` — the device↔hub control channel. */
const CONTROL_PROTOCOL_FIELDS: SchemaManifest = {
	// Inbound routing reads these off a tolerant-parsed command frame.
	CommandTolerantSchema: ["type", "cid", "role", "payload"],
	FrameTolerantSchema: ["type", "cid", "role", "payload"],
	IngestSlotTolerantSchema: [
		"endpointId",
		"host",
		"port",
		"protocol",
		"streamId",
		"instanceLabel",
		"obsInstanceId",
		"region",
		"state",
		"default",
	],
	IngestSlotsTolerantPayloadSchema: ["slots"],
	SetProfilePayloadTolerantSchema: [
		"commandId",
		"config",
		"config.presetId",
		"config.latencyMs",
		"config.fecEnabled",
		"config.recoveryMode",
		"decidedBy",
	],
	StreamConfigSchema: ["presetId", "latencyMs", "fecEnabled", "recoveryMode"],
};

/** `@ceralive/modem-control` — the certified USB-composition catalog. */
const MODEM_CONTROL_FIELDS: SchemaManifest = {
	certifiedCatalogSchema: ["entries"],
	catalogEntrySchema: [
		"vidPid",
		"model",
		"firmwarePrefix",
		"permittedTransitions",
	],
	permittedTransitionSchema: ["from", "to"],
};

const PRODUCERS: readonly {
	readonly name: string;
	readonly module: Record<string, unknown>;
	readonly fields: SchemaManifest;
}[] = [
	{
		name: "@ceralive/cerastream",
		module: cerastream as unknown as Record<string, unknown>,
		fields: CERASTREAM_FIELDS,
	},
	{
		name: "@ceralive/srtla-send",
		module: srtlaSend as unknown as Record<string, unknown>,
		fields: SRTLA_SEND_FIELDS,
	},
	{
		name: "@ceralive/control-protocol",
		module: controlProtocol as unknown as Record<string, unknown>,
		fields: CONTROL_PROTOCOL_FIELDS,
	},
	{
		name: "@ceralive/modem-control",
		module: modemControl as unknown as Record<string, unknown>,
		fields: MODEM_CONTROL_FIELDS,
	},
];

// ---------------------------------------------------------------------------
// SCHEMA PROBING
//
// Duck-typed on `safeParse`, never `instanceof z.ZodType`: each producer bundles
// its own zod, so a cross-instance `instanceof` is not a reliable guard for a
// consumer copy (the same reason `cerastream-bindings-skew.test.ts` gives).
// ---------------------------------------------------------------------------

type ZodLike = {
	readonly safeParse: (value: unknown) => unknown;
	readonly def?: Record<string, unknown>;
};

function isZodSchema(value: unknown): value is ZodLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { safeParse?: unknown }).safeParse === "function"
	);
}

/** Wrapper types whose payload is reached through `def.innerType`. */
const INNER_TYPE_WRAPPERS = new Set([
	"optional",
	"nullable",
	"default",
	"prefault",
	"nonoptional",
	"readonly",
	"catch",
]);

/** Wrapper types whose payload is reached through a named element/value type. */
const ELEMENT_WRAPPERS: Readonly<Record<string, string>> = {
	array: "element",
	set: "valueType",
	record: "valueType",
	map: "valueType",
};

const MAX_UNWRAP_DEPTH = 24;

/** Strip every transparent wrapper down to the schema that carries a shape. */
function unwrap(schema: unknown, depth = 0): unknown {
	if (depth > MAX_UNWRAP_DEPTH || !isZodSchema(schema)) return schema;
	const def = schema.def as Record<string, unknown> | undefined;
	const type = typeof def?.type === "string" ? def.type : undefined;
	if (type === undefined) return schema;

	if (INNER_TYPE_WRAPPERS.has(type)) return unwrap(def?.innerType, depth + 1);

	const elementKey = ELEMENT_WRAPPERS[type];
	if (elementKey !== undefined) return unwrap(def?.[elementKey], depth + 1);

	if (type === "lazy") {
		const getter = def?.getter;
		return typeof getter === "function"
			? unwrap((getter as () => unknown)(), depth + 1)
			: schema;
	}
	if (type === "pipe") return unwrap(def?.out ?? def?.in, depth + 1);

	return schema;
}

function shapeOf(schema: unknown): Record<string, unknown> | undefined {
	const inner = unwrap(schema);
	if (!isZodSchema(inner)) return undefined;
	const def = inner.def as Record<string, unknown> | undefined;
	if (def?.type !== "object" && def?.type !== "interface") return undefined;
	const shape = def.shape ?? (inner as { shape?: unknown }).shape;
	return typeof shape === "object" && shape !== null
		? (shape as Record<string, unknown>)
		: undefined;
}

function branchesOf(schema: unknown): readonly unknown[] | undefined {
	const inner = unwrap(schema);
	if (!isZodSchema(inner)) return undefined;
	const def = inner.def as Record<string, unknown> | undefined;
	if (def?.type === "union" && Array.isArray(def.options))
		return def.options as readonly unknown[];
	if (def?.type === "intersection") return [def.left, def.right];
	return undefined;
}

/** True when every segment of `path` resolves through the schema's shape. */
function resolvesPath(schema: unknown, segments: readonly string[]): boolean {
	const [head, ...rest] = segments;
	if (head === undefined) return true;

	const shape = shapeOf(schema);
	if (shape !== undefined && Object.hasOwn(shape, head))
		return resolvesPath(shape[head], rest);

	const branches = branchesOf(schema);
	if (branches !== undefined)
		return branches.some((branch) => resolvesPath(branch, segments));

	return false;
}

// ---------------------------------------------------------------------------

describe("producer schema drift — every consumed field exists in the installed schema", () => {
	for (const producer of PRODUCERS) {
		test(`${producer.name}: every manifest schema is exported and is a Zod schema`, () => {
			const missing: string[] = [];
			for (const schemaName of Object.keys(producer.fields)) {
				if (!isZodSchema(producer.module[schemaName]))
					missing.push(`${producer.name} → ${schemaName}`);
			}
			expect(missing).toEqual([]);
		});

		test(`${producer.name}: every consumed field path resolves`, () => {
			const drifted: string[] = [];
			for (const [schemaName, paths] of Object.entries(producer.fields)) {
				const schema = producer.module[schemaName];
				if (!isZodSchema(schema)) continue; // reported by the test above
				for (const path of paths) {
					if (!resolvesPath(schema, path.split(".")))
						drifted.push(`${producer.name} → ${schemaName}.${path}`);
				}
			}

			// A non-empty list means the installed producer pin does NOT carry a
			// field CeraUI reads. Either the pin is stale (publish-before-consume
			// was violated) or the producer retired the field and the consumer must
			// be updated in the same change.
			expect(drifted).toEqual([]);
		});
	}

	test("the manifest covers every producer and is non-empty", () => {
		expect(PRODUCERS.map((p) => p.name).sort()).toEqual([
			"@ceralive/cerastream",
			"@ceralive/control-protocol",
			"@ceralive/modem-control",
			"@ceralive/srtla-send",
		]);
		for (const producer of PRODUCERS) {
			expect(Object.keys(producer.fields).length).toBeGreaterThan(0);
			for (const paths of Object.values(producer.fields))
				expect(paths.length).toBeGreaterThan(0);
		}
	});

	// NON-VACUITY: the resolver must be able to FAIL. Without this a broken
	// unwrapper that answered `true` for everything would leave the whole gate
	// silently green — the exact class of defect the gate exists to catch.
	test("the resolver refuses a field the producer does not carry", () => {
		expect(
			resolvesPath(cerastream.captureDeviceSchema, [
				"__field_no_producer_carries__",
			]),
		).toBe(false);
		expect(
			resolvesPath(cerastream.captureDeviceSchema, [
				"caps",
				"__not_a_cap_field__",
			]),
		).toBe(false);
		// …and it must still resolve a real one, so the negative above is not the
		// resolver simply answering `false` for everything.
		expect(
			resolvesPath(cerastream.captureDeviceSchema, ["device_address"]),
		).toBe(true);
		expect(
			resolvesPath(cerastream.captureDeviceSchema, ["caps", "width"]),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// LOCKFILE PURITY
//
// The gate above only means something while the installed producer really IS
// the pinned registry release. `bun link` is the sanctioned DEV-TIME way to
// verify against an unreleased producer locally (see docs/CONVENTIONS.md →
// "Producer schema drift"), and a committed link is how that verification
// silently becomes the fleet's reality: the drift gate would then be probing a
// developer's working tree instead of the artifact devices install.
//
// This is the machine-enforced half of the documented pre-commit check
// (`grep -c 'link:' bun.lock` must be 0). It is a TEST rather than a git hook
// on purpose: the hook is best-effort and local, CI is the blocking gate.
// ---------------------------------------------------------------------------

const REPO_ROOT = `${import.meta.dir}/../../../..`;

const PRODUCER_PACKAGE_NAMES = [
	"@ceralive/cerastream",
	"@ceralive/control-protocol",
	"@ceralive/modem-control",
	"@ceralive/srtla-send",
] as const;

describe("producer pins stay registry-resolved", () => {
	test("bun.lock carries no `link:` specifier", async () => {
		const lock = await Bun.file(`${REPO_ROOT}/bun.lock`).text();
		const linked = lock
			.split("\n")
			.filter((line) => line.includes("link:"))
			.map((line) => line.trim());
		expect(linked).toEqual([]);
	});

	test("every producer dep is a bare registry version", async () => {
		const manifest = (await Bun.file(
			`${import.meta.dir}/../../package.json`,
		).json()) as { dependencies?: Record<string, string> };
		const deps = manifest.dependencies ?? {};

		const offending: string[] = [];
		for (const name of PRODUCER_PACKAGE_NAMES) {
			const spec = deps[name];
			if (spec === undefined) {
				offending.push(`${name} → absent from dependencies`);
				continue;
			}
			// A path-resolved specifier is exactly what Rule D forbids and what a
			// committed `bun link` leaves behind. The VALUE of a registry version is
			// deliberately not asserted — this gate must survive any pin that still
			// carries the manifest's fields.
			if (/^(?:link|file|workspace|portal|git|github):/.test(spec))
				offending.push(`${name} → ${spec}`);
		}
		expect(offending).toEqual([]);
	});
});
