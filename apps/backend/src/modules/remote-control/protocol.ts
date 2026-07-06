/**
 * Remote Control Plane v2.0 — device-side wire-envelope Zod schema.
 *
 * This module is the device's OWN validator for the bidirectional control
 * channel defined by `openspec/specs/remote-relay-support/spec.md`. Per that
 * spec (and Rule D — repos are self-contained), there is NO shared schema
 * package across the device/hub boundary: each repo writes its own Zod from the
 * spec, and the spec's §14 JSON fixtures are the conformance vectors. The
 * matching contract test (`protocol.contract.test.ts`) parses those fixtures
 * against the schemas below.
 *
 * Scope: framing + capability handshake only. This file does NOT touch the
 * BCRPT relay socket (`modules/remote/remote.ts`) and shares no token audience
 * with it — the control channel is a second, independent outbound WS.
 */

import { z } from "zod";

/** Protocol version carried in the envelope `v` field. Currently `1` (spec §3, §13). */
export const PROTOCOL_VERSION = 1 as const;

/** Frame discriminator values (spec §3 `kind`). */
export const FRAME_KINDS = [
	"command",
	"status",
	"result",
	"ack",
	"handshake",
	"delivery.ack",
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/**
 * Connection roles (spec §3 `role`, §12). v2.0 is owner-only and hub-stamped;
 * `copilot`/`viewer` are reserved for v2.1 delegation. Clients MUST NOT set
 * `role` and MUST ignore it inbound in v2.0.
 */
export const ROLES = ["owner", "copilot", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * INTERNAL commands (spec §5) — platform-originated, DOWNSTREAM-only (hub→device).
 * NOT operator-invocable, but IN the registry so the device's `result` /
 * `delivery.ack` echo validates platform-side (§6 / §6.1). Distinct from
 * {@link NEVER_REMOTE}: a never-remote command is local-only and MUST NEVER cross
 * the wire; an internal command IS relayed downstream — it is simply not something
 * an operator may originate. The platform additionally WITHHOLDS it from any device
 * whose `device.hello` `supportedTypes` (§4.1) does not advertise the type, so a
 * not-yet-updated device never receives a frame it cannot parse (additive,
 * safe-rollout, §13). Advertising it here is exactly what opts this device in.
 *
 * Mirrors the hub's `INTERNAL_COMMANDS` (ceralive-platform
 * `apps/api/lib/remote-control/protocol.ts`) — kept in sync by the spec, not a
 * shared package (Rule D).
 *
 * `ingest.slots` (T17/T18): the platform pushes the account-resolved ingest slots
 * to the device so the on-device UI can render + select them. Payload =
 * {@link IngestSlotsPayloadSchema}.
 *
 * `device.setProfile` (Todo 28): the platform pushes the resolved SRT receive
 * profile (a `StreamConfig` + `commandId`) so the device persists + applies it on
 * (re)connect and acks the effective active profile. The payload + ack live in
 * `@ceraui/rpc/schemas` (`setProfilePayloadSchema` / `setProfileAckSchema`).
 */
export const INTERNAL_COMMANDS = ["ingest.slots", "device.setProfile"] as const;
export type InternalCommandType = (typeof INTERNAL_COMMANDS)[number];

/**
 * The closed, explicit list of every command type the device services in v2.0
 * (spec §5 + §7 `self_fencing.confirm` + {@link INTERNAL_COMMANDS}). A `command`
 * frame's `type` MUST be one of these. This is the exact set advertised in the
 * device `device.hello` `supportedTypes` (spec §4 / §14.2) — operator-invocable
 * commands and platform-internal downstream pushes alike.
 */
export const COMMAND_REGISTRY = [
	"streaming.start",
	"streaming.stop",
	"streaming.setBitrate",
	"streaming.setConfig",
	"streaming.getConfig",
	"streaming.getPipelines",
	"network.reconfig",
	"modem.reconfig",
	"device.remoteKeyChange",
	"system.reboot",
	"device.factoryReset",
	"self_fencing.confirm",
	...INTERNAL_COMMANDS,
] as const;
export type CommandType = (typeof COMMAND_REGISTRY)[number];

/**
 * Commands that opt into the self_fencing commit-confirm watchdog (spec §5, §7).
 * Carry `self_fencing: true` at the TOP LEVEL of the frame (not in `payload`).
 */
export const SELF_FENCING_TYPES = [
	"network.reconfig",
	"modem.reconfig",
	"device.remoteKeyChange",
	"system.reboot",
	"device.factoryReset",
] as const;
export type SelfFencingType = (typeof SELF_FENCING_TYPES)[number];

/**
 * Local-only types that MUST NEVER be exposed on the control channel (spec §5).
 * The device rejects these defensively even if a malformed hub forwards one.
 */
export const NEVER_REMOTE = ["auth.login", "auth.setPassword"] as const;
export type NeverRemoteType = (typeof NEVER_REMOTE)[number];

/**
 * Relayable upstream status `type` values — the closed v2.0 set (spec §8).
 *
 * `telemetry` (spec §8.1) is the batched per-SRTLA-link telemetry surface,
 * distinct from the live `status.linkTelemetry` snapshot. It is additive
 * (non-breaking, spec §13) and read-only — it adds no command and carries no
 * secret. It is NOT a local broadcast event type, so it is intentionally NOT in
 * `status-relay.ts` `RELAYABLE_TYPES`; the device telemetry recorder emits it
 * directly over the control channel rather than through `broadcastMsg`.
 *
 * `device.activeProfile` (spec §8, cloud Todo 15) is the device reporting the
 * SRT-receive `StreamConfig` it is ACTUALLY streaming under — its EFFECTIVE active
 * profile, as opposed to the RESOLVED config the platform pushed via
 * `device.setProfile`. The platform reconciles the two to surface per-device
 * profile DRIFT (a device that did not apply the pushed profile). Additive +
 * read-only (a status frame, no command, no secret); the payload nests the four
 * StreamConfig fields under a `config` key —
 * `{ config: { presetId, latencyMs, fecEnabled, recoveryMode } }`. Unlike
 * `telemetry`, it IS in `status-relay.ts` `RELAYABLE_TYPES`: the emitter
 * (`active-profile-reporter.ts`) reports it through the standard `broadcastMsg`
 * path. Mirrors the hub's `STATUS_TYPES` entry (ceralive-platform
 * `apps/api/lib/remote-control/protocol.ts`) — kept in sync by the spec (Rule D).
 */
export const STATUS_TYPES = [
	"status",
	"config",
	"sensors",
	"netif",
	"modems",
	"device-stats",
	"notifications",
	"telemetry",
	"device.activeProfile",
] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

/**
 * The `device.activeProfile` status `type` (spec §8, cloud Todo 15), named so the
 * wire literal has a single source of truth for the emitter
 * (`active-profile-reporter.ts`). Mirrors the platform's `ACTIVE_PROFILE_STATUS`.
 */
export const ACTIVE_PROFILE_STATUS = "device.activeProfile" as const;

/** Default self_fencing watchdog window in milliseconds (spec §7 — NOT wire-negotiated). */
export const SELF_FENCING_WATCHDOG_MS = 30_000;

/** UUID v4 correlation id (spec §3 `cid`). Commands mint it; `result`/`ack` echo it. */
const cidSchema = z.uuidv4();

/** Free-form type-specific body. Unknown keys allowed (forward compat, spec §3). */
const payloadSchema = z.record(z.string(), z.unknown());

/**
 * Base envelope shared by every frame in either direction (spec §3).
 *
 * `payload`, `role`, `seq`, and `self_fencing` are optional at the envelope
 * level; the per-`kind` schemas below tighten them where the spec requires it
 * (e.g. `status` requires `seq`, `result` requires its structured payload).
 * Unknown top-level keys are ignored by receivers per §3 — Zod strips them by
 * default, which is the desired forward-compatible behavior.
 */
export const EnvelopeSchema = z.object({
	v: z.literal(PROTOCOL_VERSION),
	kind: z.enum(FRAME_KINDS),
	type: z.string().min(1),
	cid: cidSchema,
	role: z.enum(ROLES).optional(),
	payload: payloadSchema.optional(),
	seq: z.number().int().optional(),
	self_fencing: z.boolean().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * `command` frame (spec §5, §7). Downstream hub→device. `payload` is optional
 * (absent or `{}` for no-arg types). `self_fencing` rides the top level for the
 * connectivity/lifecycle ops in {@link SELF_FENCING_TYPES}.
 */
export const CommandSchema = EnvelopeSchema.extend({
	kind: z.literal("command"),
	payload: payloadSchema.optional(),
});
export type Command = z.infer<typeof CommandSchema>;

/**
 * `ingest.slots` internal-command payload (T18) — the device's OWN, deliberately
 * LENIENT validator (Rule D: each repo writes its own Zod from the spec; there is
 * no shared schema package across the device/hub boundary).
 *
 * The platform emits a STRICTER shape (ceralive-platform `protocol.ts`
 * `IngestSlotPayloadSchema`: `obsInstanceId` non-null, every descriptive field
 * required). The device tolerates more so a future platform that drops or nulls a
 * purely descriptive field never trips this schema: `obsInstanceId` may be `null`
 * and the descriptive fields (`instanceLabel`, `region`, `state`, `default`) may be
 * absent. The fields the device actually routes on — `endpointId` (slot identity),
 * `host`, `port`, `protocol`, `streamId` — stay required. Unknown keys are stripped
 * (forward compatibility, §3).
 */
export const IngestSlotSchema = z.object({
	endpointId: z.string(),
	obsInstanceId: z.string().nullable(),
	instanceLabel: z.string().optional(),
	region: z.string().optional(),
	state: z.string().optional(),
	host: z.string(),
	port: z.number(),
	protocol: z.string(),
	streamId: z.string(),
	default: z.boolean().optional(),
});
export type IngestSlot = z.infer<typeof IngestSlotSchema>;

/** Body of an `ingest.slots` command frame (spec §5 internal command). */
export const IngestSlotsPayloadSchema = z.object({
	slots: z.array(IngestSlotSchema),
});
export type IngestSlotsPayload = z.infer<typeof IngestSlotsPayloadSchema>;

/**
 * Result payload (spec §6). `applied` is the post-validation, post-clamp state
 * actually written (mirrors the existing `{ success, applied }` RPC convention);
 * `null` for commands with no applied state. `reverted: true` marks an
 * auto-reverted self_fencing op.
 */
export const ResultPayloadSchema = z.object({
	ok: z.boolean(),
	applied: z.unknown(),
	error: z.string().optional(),
	reverted: z.boolean().optional(),
});
export type ResultPayload = z.infer<typeof ResultPayloadSchema>;

/** `result` frame (spec §6). Device→hub reply to a command; echoes its `cid`. */
export const ResultSchema = EnvelopeSchema.extend({
	kind: z.literal("result"),
	payload: ResultPayloadSchema,
});
export type Result = z.infer<typeof ResultSchema>;

/**
 * `status` frame (spec §8). Upstream device→hub event. Always carries `seq`, a
 * monotonic-per-`type` integer for drop detection (resets to 0 on restart).
 */
export const StatusSchema = EnvelopeSchema.extend({
	kind: z.literal("status"),
	seq: z.number().int().nonnegative(),
});
export type Status = z.infer<typeof StatusSchema>;

/** `ack` frame (spec §4, §5, §13) — hub negotiation/rejection signal. */
export const AckSchema = EnvelopeSchema.extend({
	kind: z.literal("ack"),
});
export type Ack = z.infer<typeof AckSchema>;

/**
 * `delivery.ack` frame (spec §6.1) — the device's receipt confirmation for a
 * command, emitted upstream BEFORE the command is applied and independently of
 * any later `result`. It echoes the command's `type` and `cid` and carries no
 * payload. The hub uses it to bound its command-delivery retries (it stops
 * retrying once a matching `delivery.ack` arrives). Re-acking a replayed `cid`
 * is intentional: it lets the hub terminate retries even when the first `result`
 * never confirmed.
 */
export const DeliveryAckSchema = EnvelopeSchema.extend({
	kind: z.literal("delivery.ack"),
});
export type DeliveryAck = z.infer<typeof DeliveryAckSchema>;

/** `handshake` frame envelope (spec §4). Body lives in `payload`; `cid` is informational. */
export const HandshakeSchema = EnvelopeSchema.extend({
	kind: z.literal("handshake"),
	payload: payloadSchema.optional(),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

/**
 * Device capability object carried in `device.hello` (spec §4.1). Open for forward
 * compatibility (`catchall` keeps unknown keys), but pins the normative keys the
 * hub reads: `ceraui_version` (CalVer `YYYY.MINOR.PATCH`) and `config_schema_version`
 * (monotonic int) for the version-support gate, and `receiverKind` for the platform's
 * receiver-capability reconciliation. All are OPTIONAL for safe rollout — a hub
 * tolerates a hello that omits them (a not-yet-updated device → "version unknown" /
 * "receiver unknown → baseline" gate).
 *
 * `receiverKind` is the device's configured MEDIA-DESTINATION receiver kind
 * (`'ceralive' | 'belabox' | 'custom'`). It is derived from where the media actually
 * goes, NOT from `remote_provider` alone: a CeraLive-paired (control) device can still
 * stream its media to a custom receiver, in which case it reports `'custom'` so the
 * platform never wrongly pushes it FEC/L1. Omitted when not derivable.
 */
export const DeviceCapsSchema = z
	.object({
		ceraui_version: z.string().optional(),
		config_schema_version: z.number().int().optional(),
		receiverKind: z.string().optional(),
	})
	.catchall(z.unknown());
export type DeviceCaps = z.infer<typeof DeviceCapsSchema>;

/**
 * Device→Hub `device.hello` body (spec §4 / §14.2) — carried in the handshake
 * frame's `payload`. Advertises the protocol version, the serviceable message
 * types, and the {@link DeviceCapsSchema} capability object.
 */
export const HandshakeDeviceSchema = z.object({
	v: z.literal(PROTOCOL_VERSION),
	supportedTypes: z.array(z.string()),
	deviceCaps: DeviceCapsSchema,
});
export type HandshakeDevice = z.infer<typeof HandshakeDeviceSchema>;

/**
 * Hub→Device `hub.hello` body (spec §4 / §14.3) — carried in the handshake
 * frame's `payload`. Confirms the version and stamps the connection role
 * (always `owner` in v2.0).
 */
export const HandshakeHubSchema = z.object({
	v: z.literal(PROTOCOL_VERSION),
	role: z.enum(ROLES),
});
export type HandshakeHub = z.infer<typeof HandshakeHubSchema>;

/**
 * Discriminated union over every frame kind — the single entry point for
 * routing an inbound frame to its precise schema (downstream Tasks 13–15).
 */
export const FrameSchema = z.discriminatedUnion("kind", [
	CommandSchema,
	ResultSchema,
	StatusSchema,
	AckSchema,
	HandshakeSchema,
	DeliveryAckSchema,
]);
export type Frame = z.infer<typeof FrameSchema>;

const INTERNAL_COMMANDS_SET: ReadonlySet<string> = new Set(INTERNAL_COMMANDS);

/** True when `type` is a platform-originated, downstream-only INTERNAL command (§5). */
export function isInternalCommand(type: string): boolean {
	return INTERNAL_COMMANDS_SET.has(type);
}
