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

// The retraction half of the `hdmi_error` "No HDMI signal detected" notification.
//
// `sensors.ts`'s RK3588 dmesg watcher RAISES it off the kernel line
// `hdmirx-controller: Err, timing is invalid`. The kernel prints nothing when
// the link comes back, and a persistent notification never expires on a timer
// (`notification-liveness.ts`), so the raise was permanent: the operator read
// "No HDMI signal detected" for a port that had relocked minutes earlier.
//
// The recovery evidence is the SAME one the source list already trusts: the
// engine's own `VIDIOC_QUERY_DV_TIMINGS` projection, stamped as
// `CaptureDevice.signal` at `fromEngineDevice` — the one seam that knows the
// ENGINE authored the row. `signal: "present"` on an HDMI-RX capture device is a
// positive, engine-authored statement that the port is carrying a picture, which
// is precisely the claim the notification denies. NOTHING here is a timer: an
// unreachable engine, a fallback v4l2 scan row (`signal` unset ⇒ `unknown`), and
// a still-severed link all fail the test and leave the notification standing.

import { notificationExists, notificationRemove } from "../ui/notifications.ts";

/** Persistent-notification name shared by both `sensors.ts` HDMI raise sites. */
export const HDMI_ERROR_NOTIFICATION = "hdmi_error";

/**
 * The EXACT wire message of the no-signal raise. It is the discriminator, not
 * decoration: the name `hdmi_error` is shared with the EMI/cable-quality advisory
 * ("HDMI signal issues detected…"), which describes a DIFFERENT condition that a
 * relocked link does not falsify — the raise site already keys on this same
 * string to avoid overwriting that advisory. Retracting on anything less
 * specific would silently drop it.
 */
export const HDMI_NO_SIGNAL_MSG = "No HDMI signal detected";

/** The two device fields the verdict reads; `CaptureDevice` satisfies it. */
export interface HdmiSignalObservation {
	kind: string;
	signal?: string | undefined;
}

/**
 * Does this device view PROVE an HDMI receiver is carrying a signal again?
 *
 * Scoped to `kind === "hdmi"` — the engine's own typed capture kind, carried
 * verbatim through `mapEngineDeviceKind`. A USB/UVC dongle that captures HDMI
 * reports `usb` (the kind heuristic tests usb/uvc BEFORE hdmi precisely so such
 * dongles are not mislabelled), so a working webcam can never retract a claim
 * about the board's HDMI-RX port.
 */
export function provesHdmiSignalRecovered(
	devices: readonly HdmiSignalObservation[],
): boolean {
	return devices.some((d) => d.kind === "hdmi" && d.signal === "present");
}

/** Injected effectful surface (defaults wire the real notification store). */
export interface HdmiSignalRecoveryDeps {
	peek: (name: string) => { msg: string } | undefined;
	remove: (name: string) => unknown;
}

function defaultDeps(): HdmiSignalRecoveryDeps {
	return { peek: notificationExists, remove: notificationRemove };
}

let recoveryDeps: HdmiSignalRecoveryDeps = defaultDeps();

/** Test seam: swap the peek/remove surface (`null` restores production wiring). */
export function setHdmiSignalRecoveryDepsForTest(
	deps: HdmiSignalRecoveryDeps | null,
): void {
	recoveryDeps = deps ?? defaultDeps();
}

/**
 * Retract the standing "No HDMI signal detected" notification once an HDMI
 * receiver reports a locked signal again. Returns whether a removal was emitted,
 * so a caller (and a test) can assert the edge without inspecting the broadcast.
 *
 * Idempotent by construction: `notificationExists` answers `undefined` once the
 * notification is gone, so a steady stream of healthy device commits costs one
 * map lookup and broadcasts nothing.
 */
export function clearHdmiSignalErrorOnRecovery(
	devices: readonly HdmiSignalObservation[],
	deps: HdmiSignalRecoveryDeps = recoveryDeps,
): boolean {
	if (!provesHdmiSignalRecovered(devices)) return false;
	const standing = deps.peek(HDMI_ERROR_NOTIFICATION);
	if (standing?.msg !== HDMI_NO_SIGNAL_MSG) return false;
	deps.remove(HDMI_ERROR_NOTIFICATION);
	return true;
}
