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
 * The closed, explicit list of every remote-invokable command type in v2.0
 * (spec §5 + §7 `self_fencing.confirm`). A `command` frame's `type` MUST be one
 * of these. This is the exact set advertised in the device `device.hello`
 * `supportedTypes` (spec §4 / §14.2).
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

/** Relayable upstream status `type` values — the closed v2.0 set (spec §8). */
export const STATUS_TYPES = [
	"status",
	"config",
	"sensors",
	"netif",
	"modems",
	"device-stats",
	"notifications",
] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

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

/** `handshake` frame envelope (spec §4). Body lives in `payload`; `cid` is informational. */
export const HandshakeSchema = EnvelopeSchema.extend({
	kind: z.literal("handshake"),
	payload: payloadSchema.optional(),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

/**
 * Device→Hub `device.hello` body (spec §4 / §14.2) — carried in the handshake
 * frame's `payload`. Advertises the protocol version, the serviceable message
 * types, and a free-form capability object.
 */
export const HandshakeDeviceSchema = z.object({
	v: z.literal(PROTOCOL_VERSION),
	supportedTypes: z.array(z.string()),
	deviceCaps: z.record(z.string(), z.unknown()),
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
]);
export type Frame = z.infer<typeof FrameSchema>;
