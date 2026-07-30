/*
    CeraUI - web UI for the CERALIVE project
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

/*
 * ABSENCE HYSTERESIS for the selected capture source — the Auto-audio half.
 *
 * Every existing timing defence in this chain is an EVENT DEBOUNCE: the `/dev`
 * watch waits 200 ms for quiet before re-reading, the audio scan waits 500 ms,
 * cerastream's registry debounces adds/removes by 250 ms. Not one of them is an
 * ABSENCE GRACE PERIOD — a wait-before-believing-it-is-gone — so a hole in the
 * device view of any length at all propagates straight to a verdict.
 *
 * libuvc opens a UVC-H.264 camera through usbfs, which detaches `uvcvideo` from
 * the device's VideoControl + VideoStreaming interfaces for the session. That
 * rebind is NORMAL and necessary — measured on a board (2026-07-30, DJI Osmo
 * Pocket 3 `2ca3:0023` on `usb5`/EHCI), it involves NO USB device reset: `devnum`
 * is unchanged, only interfaces `1.0`/`1.1` move `uvcvideo → usbfs → uvcvideo`,
 * the camera's ALSA card stays bound throughout, and even its PCM node inode is
 * preserved. While the engine HOLDS the device its own `held_devices` record
 * masks the gap correctly. On RELEASE it does not: the engine drops the held
 * record before the successor node is rediscovered, and `list-devices` answers
 * without the camera's video row for a window measured at ≈400 ms and bounded
 * above by the 2.0 s worst-case node re-registration. The same window was
 * observed firing spontaneously twice more within 30 s of an ordinary preview
 * closing, so it is hit during normal operation, not only on operator action.
 *
 * `resolveAutoAsrc` rule 5 joins a USB/UVC camera to its OWN audio card on
 * `physical_group_id` equality. During the window that join has nothing to match:
 * either the video row is absent outright, or CeraUI's hotplug merge has restored
 * it from `lastEngineVideoDevices` — which deliberately restores durable IDENTITY
 * (`kind`/`stable_id`) and NEVER a same-moment topology relation like
 * `physical_group_id`. Auto therefore resolved `no-same-device-audio`, the meter
 * preference went `null`, and the operator read "Meter unavailable · No audio
 * device" for a microphone that was bound and streaming the whole time.
 *
 * FOUR properties are load-bearing:
 *
 *  - It is hysteresis on the VERDICT, not on the sampling. Nothing here changes
 *    when the device list is read, what it contains, or what `sources` puts on
 *    the wire — the `lost` row, the source picker, and routing are untouched.
 *    Only the answer to "is the selected camera present RIGHT NOW" is held.
 *  - The clock starts at the FIRST DEGRADED OBSERVATION, never at the last
 *    healthy one. Our knowledge of the device is refreshed on someone else's
 *    cadence (the 5 s signal recheck, a hotplug tick), so a window measured from
 *    the memory's age would expire in steady state and never fire when needed.
 *    "How long we have tolerated a degraded view" is the quantity that matters.
 *  - It is STRICTLY BOUNDED and self-clearing. After
 *    `CAPTURE_ABSENCE_GRACE_MS` of UNINTERRUPTED degradation the memory is
 *    dropped and the live view is reported verbatim, so a true unplug is
 *    reported exactly as it was before this module existed. A grace period that
 *    can be renewed by anything other than a genuinely healthy observation would
 *    be a permanent suppression wearing a timer's clothes.
 *  - It follows the DEVICE, not the node path. The memory is matched by stable
 *    identity (`stableId`, or the retired ids the successor publishes as
 *    `previousIds`) before its node id, because a libuvc camera renumbers
 *    `/dev/videoN` on every open/close cycle — the very cycle this exists for.
 *    A different device that merely took the freed node never inherits it.
 */

import type { StreamSource } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";

/**
 * How long a DEGRADED view of the selected capture source is tolerated before it
 * is believed.
 *
 * Sized against both halves of the measured rebind: comfortably over the ≈400 ms
 * engine release hole and at the 2.0 s ceiling of the close→node-back
 * re-registration. It is deliberately NOT larger — it sits just under the audio
 * meter's own `AUDIO_METER_FRAME_ABSENCE_MS` (2 500 ms), so this grace can never
 * outlive the watchdog that recovers a genuinely dead feed, and a real unplug
 * still reaches the operator within one meter frame of the window closing.
 */
export const CAPTURE_ABSENCE_GRACE_MS = 2_000;

/** The remembered last-known-good view, plus the current degraded run's start. */
interface CapturePresenceMemory {
	source: StreamSource;
	/** Set on the FIRST degraded observation; cleared by any healthy one. */
	degradedSince: number | undefined;
}

let memory: CapturePresenceMemory | undefined;

let clock: () => number = getms;

/** Test seam: pin the monotonic clock (`undefined` restores `getms`). */
export function setCapturePresenceClockForTest(
	fn: (() => number) | undefined,
): void {
	clock = fn ?? getms;
}

/** Drop the remembered view — test isolation and explicit re-arm only. */
export function resetCapturePresence(): void {
	memory = undefined;
}

/** Whether a grace window is currently being served (diagnostics + tests). */
export function isCaptureAbsenceGraceActive(): boolean {
	return memory?.degradedSince !== undefined;
}

/**
 * The Auto-audio join key a row carries. Only a capture row can have one — a
 * coarse/virtual/network row is a static offering with no USB topology at all.
 */
function joinKey(source: StreamSource | undefined): string | undefined {
	if (source === undefined || source.origin !== "capture") return undefined;
	const group = source.physicalGroupId;
	return group === undefined || group === "" ? undefined : group;
}

function stableIdOf(source: StreamSource | undefined): string | undefined {
	if (source === undefined || source.origin !== "capture") return undefined;
	const id = source.stableId;
	return id === undefined || id === "" ? undefined : id;
}

/**
 * Does the remembered view describe the SAME PHYSICAL DEVICE the selection now
 * names?
 *
 * Stable identity OUTRANKS the node path, in BOTH directions, and the second
 * direction is the one that matters: the kernel recycles `/dev/videoN`, so a
 * different camera can be sitting on the exact id the memory was recorded
 * under. Two rows that BOTH carry a stable id therefore settle the question
 * outright — equal proves the renumber, unequal proves the substitution — and a
 * borrowed `physical_group_id` can never bind Auto audio to the microphone of a
 * device the operator is no longer pointing at.
 *
 * Only when the evidence runs out (nothing live to compare, or an engine that
 * emits no `stable_id`) does the node path decide, which is byte-identical to
 * the behaviour before stable ids existed.
 */
function isSameDevice(
	remembered: StreamSource,
	selectedId: string,
	live: StreamSource | undefined,
): boolean {
	const rememberedStableId = stableIdOf(remembered);
	const liveStableId = stableIdOf(live);
	if (rememberedStableId !== undefined && liveStableId !== undefined) {
		return rememberedStableId === liveStableId;
	}
	if (
		rememberedStableId !== undefined &&
		live?.origin === "capture" &&
		(live.previousIds?.includes(remembered.id) ?? false)
	) {
		return true;
	}
	return remembered.id === selectedId;
}

/**
 * Is this live view WORSE at answering the Auto-audio question than the one we
 * remember? Three ways, in order of bluntness: the row is gone, the row is a
 * remembered `lost` placeholder, or the row is present but has lost the
 * `physical_group_id` it was carrying a moment ago.
 *
 * The third clause is the one the libuvc window actually produces, and it is not
 * a special case bolted on: `withKnownEngineMetadata` restores durable identity
 * and refuses to re-assert a same-moment topology relation, by design and for
 * good reason. So "the row is there" is simply not the question rule 5 asks.
 */
function isDegraded(
	live: StreamSource | undefined,
	remembered: StreamSource | undefined,
): boolean {
	if (live === undefined) return true;
	if (live.lost === true) return true;
	if (remembered === undefined) return false;
	return joinKey(remembered) !== undefined && joinKey(live) === undefined;
}

/**
 * Resolve the operator's selected source for AUTO-AUDIO purposes, holding a
 * last-known-good view across a sub-`CAPTURE_ABSENCE_GRACE_MS` degradation.
 *
 * Returns the live row whenever the live row is at least as good as what we
 * remember, the remembered row while a bounded degraded run is in progress, and
 * the live row again — honestly, degraded or absent — the moment the window
 * closes.
 */
export function resolveSelectedSourceWithGrace(
	selectedId: string | undefined,
	sources: readonly StreamSource[],
	now: number = clock(),
): StreamSource | undefined {
	if (selectedId === undefined || selectedId === "") {
		memory = undefined;
		return undefined;
	}

	const live = sources.find((s) => s.id === selectedId);

	// A coarse/virtual/network selection has no presence verdict to hold: it is
	// an offering, not a device, and it cannot blink out under a USB rebind.
	if (live !== undefined && live.origin !== "capture") {
		memory = undefined;
		return live;
	}

	const remembered =
		memory !== undefined && isSameDevice(memory.source, selectedId, live)
			? memory
			: undefined;
	// A memory that no longer describes the selected device is not evidence
	// about it, and holding it would let one camera vouch for another.
	if (remembered === undefined) memory = undefined;

	if (!isDegraded(live, remembered?.source)) {
		memory =
			live === undefined
				? undefined
				: { source: live, degradedSince: undefined };
		return live;
	}

	// Degraded with nothing to fall back on: the live view IS our best answer.
	if (remembered === undefined) return live;

	const since = remembered.degradedSince ?? now;
	remembered.degradedSince = since;
	if (now - since <= CAPTURE_ABSENCE_GRACE_MS) return remembered.source;

	memory = undefined;
	logger.debug(
		`capture presence: selected source degraded for more than ${CAPTURE_ABSENCE_GRACE_MS} ms — reporting the live view`,
		{ selectedId, present: live !== undefined },
	);
	return live;
}
