/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Compile-time skew assertions for the CeraUI-OWNED wire schemas that MIRROR a
 * producer shape rather than consuming one.
 *
 * Four schemas in `@ceraui/rpc` are re-broadcast to the frontend on CeraUI's own
 * wire, so they are legitimately CeraUI-owned and must NOT import a producer
 * type (`@ceraui/rpc` deliberately carries no `@ceralive/cerastream` dependency,
 * and it is browser-safe). But each declares in prose that it mirrors a producer
 * shape, and prose does not fail a build — a producer rename left them silently
 * describing a field that no longer arrives.
 *
 * This module is that missing gate. It lives in `apps/backend`, the one package
 * that depends on BOTH sides, and it is type-only: it adds no runtime code, no
 * import edge into `@ceraui/rpc`, and no browser-unsafe dependency. It is
 * typechecked because `apps/backend/tsconfig.json` INCLUDES the `src` tree (a
 * `src/tests` placement would NOT be — tests are excluded from the gate).
 *
 * MECHANISM, and why the `Pick` is doing the work rather than decorating it: a
 * producer RENAME makes `Pick<Producer, "renamed_away">` an invalid key list and
 * fails immediately, while a producer TYPE change survives the `Pick` and is
 * caught by the two-directional assignability assertions beside it. Both are
 * needed; either alone leaves half the drift silent.
 *
 * The subsets deliberately exclude CeraUI-owned facets (`captureDevice.kind` /
 * `lost` / `signal`, `audioLevel.reason`'s two CeraUI-authored members), which
 * are not producer-derived and must stay free to diverge.
 */

import type {
	ActiveEncode as CerastreamActiveEncode,
	AudioLevelEvent as CerastreamAudioLevelEvent,
	CaptureDevice as CerastreamCaptureDevice,
	CaptureCap as CerastreamCaptureFormatCap,
	PlatformCaps as CerastreamPlatformCaps,
	StatusEvent as CerastreamStatusEvent,
	VideoSourceCap as CerastreamVideoSourceCap,
} from "@ceralive/cerastream";
import type {
	CaptureFormatCap,
	PlatformCaps,
	VideoSourceCap,
} from "@ceraui/rpc";
import type {
	ActiveEncode,
	AudioLevelMessage,
	BufferingStatus,
	CaptureDevice,
} from "@ceraui/rpc/schemas";

/**
 * Fails to compile unless `Source` is assignable to `Target`. Used in BOTH
 * directions so a widened OR narrowed producer field is caught, not just a
 * removed one.
 */
type AssertAssignable<Source extends Target, Target> = Source;

/** The producer-derived key set of a CeraUI mirror, resolved on the PRODUCER. */
type ProducerView<Producer, Keys extends keyof Producer> = Pick<Producer, Keys>;

// ---------------------------------------------------------------------------
// S2 — `streaming.schema.ts` `captureDeviceSchema`
//
// CeraUI re-broadcasts this to the frontend with three UI facets the producer
// knows nothing about (`kind` for grouping, `lost` for the unplugged-during-
// session grace state, `signal` for present-but-nothing-arriving), so the schema
// is CeraUI's. Everything else is the producer's `captureDeviceSchema` verbatim.
// ---------------------------------------------------------------------------

type CaptureDeviceProducerKeys =
	| "input_id"
	| "device_path"
	| "display_name"
	| "media_class"
	| "caps"
	| "modes"
	| "stable_id"
	| "physical_group_id";

type CaptureDeviceMirror = Pick<CaptureDevice, CaptureDeviceProducerKeys>;
type CaptureDeviceProducer = ProducerView<
	CerastreamCaptureDevice,
	CaptureDeviceProducerKeys
>;

export type CaptureDeviceMirrorsProducer = AssertAssignable<
	CaptureDeviceMirror,
	CaptureDeviceProducer
>;
export type ProducerMirrorsCaptureDevice = AssertAssignable<
	CaptureDeviceProducer,
	CaptureDeviceMirror
>;

// ---------------------------------------------------------------------------
// S3 — `capabilities/intersect-caps.ts` `PlatformCaps` / `VideoSourceCap` /
// `CaptureFormatCap`
//
// Hand-written interfaces (not Zod), because `intersect-caps.ts` is a pure,
// browser-safe derivation consumed by the frontend. `PlatformCaps` is a strict
// SUBSET of the producer's — the producer additionally carries `hardware_kind`
// and `source`, which this layer has no opinion about — so only the
// producer-satisfies-mirror direction is asserted for it.
// ---------------------------------------------------------------------------

type PlatformCapsProducer = ProducerView<
	CerastreamPlatformCaps,
	keyof PlatformCaps
>;

export type PlatformCapsMirrorsProducer = AssertAssignable<
	PlatformCaps,
	PlatformCapsProducer
>;
export type ProducerMirrorsPlatformCaps = AssertAssignable<
	PlatformCapsProducer,
	PlatformCaps
>;

type VideoSourceCapProducer = ProducerView<
	CerastreamVideoSourceCap,
	keyof VideoSourceCap
>;

export type VideoSourceCapMirrorsProducer = AssertAssignable<
	VideoSourceCap,
	VideoSourceCapProducer
>;
export type ProducerMirrorsVideoSourceCap = AssertAssignable<
	VideoSourceCapProducer,
	VideoSourceCap
>;

type CaptureFormatCapProducer = ProducerView<
	CerastreamCaptureFormatCap,
	keyof CaptureFormatCap
>;

export type CaptureFormatCapMirrorsProducer = AssertAssignable<
	CaptureFormatCap,
	CaptureFormatCapProducer
>;
export type ProducerMirrorsCaptureFormatCap = AssertAssignable<
	CaptureFormatCapProducer,
	CaptureFormatCap
>;

// ---------------------------------------------------------------------------
// S4 — `status.schema.ts` `bufferingStatusSchema` + `activeEncodeSchema`
//
// Both are declared pass-through shapes ("snake_case mirrors the engine wire
// shape so the backend passes it through untransformed").
//
// `bufferingStatus` is the ONE mirror that restructures: the producer publishes
// the four buffering facts FLAT on its `status` event, and CeraUI nests them
// under one object whose `active` renames the producer's `buffering`. So the
// three counters are asserted by name and `active` is asserted against the
// producer field it renames — never by key equality, which would be false.
//
// `engineBitrateSchema` is deliberately ABSENT from this file: its own comment
// records that it is assembled from a separate event topic and is NOT a verbatim
// pass-through, so asserting it against the producer would pin a mirror that
// does not exist.
// ---------------------------------------------------------------------------

type BufferingCounterKeys =
	| "spooled_bytes"
	| "data_headroom_bytes"
	| "disk_warning";

type BufferingCountersMirror = Pick<BufferingStatus, BufferingCounterKeys>;
type BufferingCountersProducer = ProducerView<
	CerastreamStatusEvent,
	BufferingCounterKeys
>;

export type BufferingCountersMirrorProducer = AssertAssignable<
	BufferingCountersMirror,
	BufferingCountersProducer
>;
export type ProducerMirrorsBufferingCounters = AssertAssignable<
	BufferingCountersProducer,
	BufferingCountersMirror
>;

export type BufferingActiveMirrorsProducerBuffering = AssertAssignable<
	NonNullable<CerastreamStatusEvent["buffering"]>,
	BufferingStatus["active"]
>;

type ActiveEncodeProducer = ProducerView<
	CerastreamActiveEncode,
	keyof ActiveEncode
>;

export type ActiveEncodeMirrorsProducer = AssertAssignable<
	ActiveEncode,
	ActiveEncodeProducer
>;
export type ProducerMirrorsActiveEncode = AssertAssignable<
	ActiveEncodeProducer,
	ActiveEncode
>;

// ---------------------------------------------------------------------------
// S5 — `audio-level.schema.ts` `audioLevelMessageSchema`
//
// The producer's envelope (`type` / `seq`) is stripped by the broadcast layer,
// so the mirror is the PAYLOAD only.
//
// `reason` is asserted ONE-DIRECTIONALLY on purpose. CeraUI's enum is a strict
// SUPERSET: `not_selected_device` and `embedded_audio` are CeraUI-authored gaps
// the engine never emits (see that file's own comment). Every producer reason
// must remain renderable, but a CeraUI-owned reason must stay free to exist.
// ---------------------------------------------------------------------------

type AudioLevelPayloadKeys =
	| "source"
	| "channels"
	| "rms_db"
	| "peak_db"
	| "floor_db"
	| "unavailable";

type AudioLevelMirror = Pick<AudioLevelMessage, AudioLevelPayloadKeys>;
type AudioLevelProducer = ProducerView<
	CerastreamAudioLevelEvent,
	AudioLevelPayloadKeys
>;

export type AudioLevelMirrorsProducer = AssertAssignable<
	AudioLevelMirror,
	AudioLevelProducer
>;
export type ProducerMirrorsAudioLevel = AssertAssignable<
	AudioLevelProducer,
	AudioLevelMirror
>;

export type ProducerAudioLevelReasonsAreRenderable = AssertAssignable<
	NonNullable<CerastreamAudioLevelEvent["reason"]>,
	NonNullable<AudioLevelMessage["reason"]>
>;
