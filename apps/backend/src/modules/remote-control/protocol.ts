/**
 * Remote Control Plane v2.0 — device-side wire-envelope schema surface.
 *
 * This module is now a THIN re-export of the canonical
 * `@ceralive/control-protocol` npm package (`@ceralive` scope, pinned to an exact
 * CalVer version in `package.json`). The package is the single Zod derivation of
 * the control-channel wire contract (`openspec/specs/remote-relay-support/spec.md`)
 * consumed identically by BOTH this device (`CeraUI/apps/backend`) and the cloud
 * hub (`ceralive-platform`) — replacing the two previously-independent hand-written
 * per-repo `protocol.ts` derivations.
 *
 * The device/hub PARSING ASYMMETRY is preserved byte-for-byte: the package ships an
 * explicit `*Strict*` (hub) and `*Tolerant*` (device) variant of every frame/payload
 * that differs between the two sides. This module re-exports the DEVICE-TOLERANT
 * variant under each of the historical un-suffixed device names (`CommandSchema`,
 * `StatusSchema`, `FrameSchema`, …), so every downstream importer
 * (`channel.ts`, `command-router.ts`, `status-relay.ts`, `set-profile.ts`,
 * `ingest-slots.ts`, `self-fencing.ts`, `active-profile-reporter.ts`) keeps the
 * exact schema it had before, with no import-site or behaviour change. The
 * `tolerantParse*` helpers are re-exported alongside so new call sites can use the
 * named device-posture parser directly.
 *
 * Registry-dependency consumption stays Rule-D-compatible (root `AGENTS.md`):
 * `@ceralive/control-protocol` resolves through the package registry identically
 * whether or not the sibling repo is checked out — it is a CalVer registry dep like
 * `@ceralive/cerastream` / `@ceraui/srtla-send`, NOT a sibling `link:` or a `../`
 * path reference. Evolution is additive-optional forever (see the package README →
 * "Evolution policy"): a change that would make a currently-optional field required
 * is a new protocol `v`, never a version bump of the package.
 *
 * Scope: framing + capability handshake only. This file does NOT touch the BCRPT
 * relay socket (`modules/remote/remote.ts`) and shares no token audience with it —
 * the control channel is a second, independent outbound WS.
 */

export type {
	CommandType,
	DeviceCaps,
	Envelope,
	FrameKind,
	InternalCommandType,
	NeverRemoteType,
	ResultPayload,
	Role,
	SelfFencingType,
	StatusType,
} from "@ceralive/control-protocol/schemas";
// ── Pass-through: constants, enums, and schemas identical on both sides ────────
export {
	// constants / closed registries (§3, §5, §8, §13)
	ACTIVE_PROFILE_STATUS,
	COMMAND_REGISTRY,
	// shared schemas (no strict/tolerant split — byte-identical on both sides)
	DeviceCapsSchema,
	EnvelopeSchema,
	FRAME_KINDS,
	INTERNAL_COMMANDS,
	// type guards
	isInternalCommand,
	NEVER_REMOTE,
	PROTOCOL_VERSION,
	ResultPayloadSchema,
	ROLES,
	SELF_FENCING_TYPES,
	SELF_FENCING_WATCHDOG_MS,
	STATUS_TYPES,
} from "@ceralive/control-protocol/schemas";

import type {
	AckTolerant,
	CommandTolerant,
	DeliveryAckTolerant,
	FrameTolerant,
	HandshakeDeviceBody,
	HandshakeEnvelope,
	HandshakeHubBody,
	IngestSlotsTolerantPayload,
	IngestSlotTolerant,
	ResultTolerant,
	StatusTolerant,
} from "@ceralive/control-protocol/schemas";
// ── Device-TOLERANT variants, re-exported under the historical device names ────
//
// The package's un-suffixed alias for each of these colliding names resolves to
// the STRICT (hub) variant; the device deliberately keeps its looser posture, so
// we bind each device name to the explicit `*Tolerant*` schema. This preserves the
// device's forward-compatible leniency (open `type`, nullable/absent descriptive
// `ingest.slots` fields, any-string `commandId`) exactly as before.
import {
	AckTolerantSchema,
	CommandTolerantSchema,
	DeliveryAckTolerantSchema,
	FrameTolerantSchema,
	HandshakeDeviceBodySchema,
	HandshakeEnvelopeSchema,
	HandshakeHubBodySchema,
	IngestSlotsTolerantPayloadSchema,
	IngestSlotTolerantSchema,
	ResultTolerantSchema,
	StatusTolerantSchema,
} from "@ceralive/control-protocol/schemas";

/** `command` frame — device-tolerant (`type` any non-empty string, §5). */
export const CommandSchema = CommandTolerantSchema;
export type Command = CommandTolerant;

/** `result` frame — device-tolerant (§6). */
export const ResultSchema = ResultTolerantSchema;
export type Result = ResultTolerant;

/** `status` frame — device-tolerant; `seq` required + non-negative (§8). */
export const StatusSchema = StatusTolerantSchema;
export type Status = StatusTolerant;

/** `ack` frame — device-tolerant (§4, §5, §13). */
export const AckSchema = AckTolerantSchema;
export type Ack = AckTolerant;

/** `delivery.ack` frame — device-tolerant; carries no payload (§6.1). */
export const DeliveryAckSchema = DeliveryAckTolerantSchema;
export type DeliveryAck = DeliveryAckTolerant;

/** Whole-frame discriminated union over `kind` — device-tolerant (§3). */
export const FrameSchema = FrameTolerantSchema;
export type Frame = FrameTolerant;

/**
 * Single, body-agnostic `handshake` FRAME (§4) — the device's historical
 * `HandshakeSchema` shape (`kind:"handshake"`, `type` open, hello body in
 * `payload`). Distinct from the package's un-suffixed `HandshakeSchema`, which is
 * the union of the two full hub frames.
 */
export const HandshakeSchema = HandshakeEnvelopeSchema;
export type Handshake = HandshakeEnvelope;

/**
 * Device→Hub `device.hello` BODY (§4 / §14.2 `payload`) — the device's historical
 * `HandshakeDeviceSchema` shape (`{v, supportedTypes, deviceCaps}`).
 */
export const HandshakeDeviceSchema = HandshakeDeviceBodySchema;
export type HandshakeDevice = HandshakeDeviceBody;

/** Hub→Device `hub.hello` BODY (§4 / §14.3 `payload`) — `{v, role}`. */
export const HandshakeHubSchema = HandshakeHubBodySchema;
export type HandshakeHub = HandshakeHubBody;

/** Single `ingest.slots` slot — device-tolerant (§5.1). */
export const IngestSlotSchema = IngestSlotTolerantSchema;
export type IngestSlot = IngestSlotTolerant;

/** Body of an `ingest.slots` command frame — device-tolerant (§5.1). */
export const IngestSlotsPayloadSchema = IngestSlotsTolerantPayloadSchema;
export type IngestSlotsPayload = IngestSlotsTolerantPayload;

// ── Named device-posture parse helpers (the tolerant lane of the shared package) ─
export {
	parseHandshakeDeviceBody,
	parseHandshakeHubBody,
	tolerantParseAck,
	tolerantParseCommand,
	tolerantParseDeliveryAck,
	tolerantParseFrame,
	tolerantParseFrameSafe,
	tolerantParseHandshake,
	tolerantParseIngestSlots,
	tolerantParseIngestSlotsSafe,
	tolerantParseResult,
	tolerantParseSetProfilePayload,
	tolerantParseSetProfilePayloadSafe,
	tolerantParseStatus,
} from "@ceralive/control-protocol/parse";
