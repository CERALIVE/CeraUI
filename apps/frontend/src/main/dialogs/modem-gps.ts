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
 * What the GPS section renders, as pure data.
 *
 * The interesting decisions here are rules — WHEN the control is offered, and
 * WHAT an operator is told while there is no fix — and a rule stated once in a
 * `.ts` file can be tested against every input class without mounting anything.
 * It follows `modem-fcc-unlock.ts` exactly, for the same reason.
 *
 * THE PRIVACY FENCE REACHES THIS LAYER TOO: there is no history view, no export
 * button, and no map link. `gnssFixLine` renders ONE fix, the one currently in
 * the device's memory, and nothing accumulates.
 */

import type {
	GnssFix,
	GnssFixState,
	SupportClaimState,
} from "@ceraui/rpc/schemas";

import {
	type CapabilityReasonKeys,
	resolveCapabilityRender,
} from "../network/capability-modules";

export type GpsView =
	/** CT-1: positively unsupported or not shipped — ZERO DOM nodes. */
	| { readonly kind: "absent" }
	/** CT-3: nothing established about this modem — a distinct diagnostic, no control. */
	| { readonly kind: "unknown"; readonly reasonKey: string }
	/** CT-2: supported, refused right now — the control renders DISABLED with this reason. */
	| { readonly kind: "blocked"; readonly reasonKey: string }
	| { readonly kind: "toggle"; readonly enabled: boolean };

/**
 * `unproven` covers BOTH sub-cases of a `enabled` claim — nothing has been read
 * yet, and a read that could not settle it — because the wire cannot tell them
 * apart: the evidence behind `gps` is process-local and resets on boot, so the
 * first operator after a restart meets exactly the same `unknown` as one whose
 * probe failed. So it states what is not yet known rather than reaching a
 * verdict about the hardware, and it says the same thing on every render, which
 * is CT-5: a per-mount "checking…" transient would make the same evidence render
 * two different ways depending on when it was looked at.
 */
const REASONS: CapabilityReasonKeys = {
	moduleDisabled: "network.modem.gps.reason.moduleDisabled",
	unproven: "network.modem.gps.reason.unproven",
};

/**
 * Resolve what to render for one modem. The claim ladder routes through the
 * shared `resolveCapabilityRender`, exactly as `fccUnlockView` does, so the two
 * gated modules cannot answer the same claim two different ways.
 *
 * The one LOCAL fact is a ≥`capable` modem that has published no status block
 * yet: the receiver is proven to exist, so the toggle is rendered DISABLED with
 * its reason (CT-2) rather than withheld — withholding it would be
 * indistinguishable from a modem that has no GNSS at all.
 */
export function gpsView(
	claim: SupportClaimState | undefined,
	status: { readonly gnssEnabled: boolean } | undefined,
): GpsView {
	const view = resolveCapabilityRender(
		claim,
		REASONS,
		status === undefined ? "network.modem.gps.reason.notReported" : undefined,
	);
	switch (view.mode) {
		case "absent":
			return { kind: "absent" };
		case "unknown":
			return { kind: "unknown", reasonKey: view.reasonKey };
		case "blocked":
			return { kind: "blocked", reasonKey: view.reasonKey };
		case "available":
			return { kind: "toggle", enabled: status?.gnssEnabled === true };
	}
}

export type GpsStatusLine =
	| { readonly kind: "off" }
	/** A BOUNDED wait. `deadline` is what the copy states, so it is never open-ended. */
	| { readonly kind: "acquiring"; readonly deadline: number }
	| { readonly kind: "no-fix"; readonly reasonKey: string }
	| { readonly kind: "fix"; readonly fix: GnssFix }
	| { readonly kind: "unavailable" };

/**
 * The renderable form of the device's state.
 *
 * `no-fix` keys its copy on WHY, because the three reasons ask for different
 * things from an operator: a timed-out acquisition points at the antenna, a
 * receiver still reporting nothing is simply not locked on, and an expired fix
 * says the position went stale and was dropped rather than shown.
 *
 * `acquireExpired` is the RENDER-SIDE half of the same bound the device's own
 * state machine applies, and it exists because that machine is advanced ONLY by
 * a read — a modem that stops answering leaves the wire state on `acquiring`
 * forever, which is precisely the endless spinner the bound was written to make
 * impossible. It is not a second authority about the device: it re-states the
 * device's own declared window as its own declared terminal state, and it can
 * only ever turn a bounded wait into `no-fix`. Defaulted to `false`, so every
 * caller that does not measure the wait is byte-identical.
 */
export function gpsStatusLine(
	state: GnssFixState | undefined,
	acquireExpired = false,
): GpsStatusLine {
	if (state === undefined) return { kind: "off" };
	switch (state.kind) {
		case "off":
			return { kind: "off" };
		case "acquiring":
			return acquireExpired
				? {
						kind: "no-fix",
						reasonKey: "network.modem.gps.noFix.acquire-timeout",
					}
				: { kind: "acquiring", deadline: state.deadline };
		case "no-fix":
			return {
				kind: "no-fix",
				reasonKey: `network.modem.gps.noFix.${state.reason}`,
			};
		case "fix":
			return { kind: "fix", fix: state.fix };
		case "unavailable":
			return { kind: "unavailable" };
	}
}

/**
 * How often the surface re-reads the device while it is acquiring.
 *
 * The device's state machine has NO background poller — that is part of the
 * privacy fence, because it makes "a position exists only while somebody is
 * looking at it" true by construction. This re-read does not weaken it: it runs
 * only while this section is MOUNTED and only while the wait is live, which is
 * exactly "an operator is looking at the card".
 */
export const GNSS_ACQUIRE_POLL_MS = 5_000;

/**
 * The acquisition wait, measured in a clock this surface can trust.
 *
 * `since`/`deadline` are stamped by the DEVICE, so comparing either against the
 * browser's clock is wrong by whatever the two disagree by — and a browser
 * running ahead would report `no-fix` the instant the wait began. The DURATION
 * is a difference of two device timestamps, so it is skew-free; the elapsed part
 * is measured from the moment this surface first observed the wait.
 */
export interface GnssAcquireWindow {
	readonly durationMs: number;
	readonly observedAt: number;
}

export function gnssAcquireWindow(
	state: GnssFixState | undefined,
	observedAt: number,
): GnssAcquireWindow | undefined {
	if (state?.kind !== "acquiring") return undefined;
	return {
		durationMs: Math.max(0, state.deadline - state.since),
		observedAt,
	};
}

export function gnssAcquireExpired(
	window: GnssAcquireWindow | undefined,
	now: number,
): boolean {
	return window !== undefined && now - window.observedAt >= window.durationMs;
}

/** `undefined` once the wait is over — the surface arms nothing after that. */
export function gnssAcquirePollDelay(
	window: GnssAcquireWindow | undefined,
	now: number,
): number | undefined {
	if (gnssAcquireExpired(window, now) || window === undefined) return undefined;
	const remaining = window.durationMs - (now - window.observedAt);
	return Math.max(0, Math.min(GNSS_ACQUIRE_POLL_MS, remaining));
}

/**
 * A fix as ONE line of text.
 *
 * Six decimal places is ~0.1 m, which is far finer than any modem's GNSS is
 * accurate to — but truncating a coordinate makes it look like a different
 * place, so the device's own figure is rendered rather than a rounded one.
 * `dir="ltr"` is applied at the render site so an RTL locale cannot reorder the
 * two signed numbers.
 */
export function gnssFixLine(fix: GnssFix): string {
	const parts = [`${fix.latitude.toFixed(6)}, ${fix.longitude.toFixed(6)}`];
	if (fix.altitude !== undefined) {
		parts.push(`${Math.round(fix.altitude)} m`);
	}
	return parts.join(" · ");
}

/**
 * The i18n key for a `setGps` failure. A raw machine token is never rendered —
 * the rule the rest of the modem surface follows — and an UNMAPPED token falls
 * back to the generic write failure rather than leaking itself into copy.
 */
export function gpsErrorKey(token: string): string {
	const known = new Set([
		"unsupported",
		"not_enabled",
		"unknown_modem",
		"read_failed",
		"module_disabled",
		"module_unavailable",
		"mutation_blocked",
		"mutation_in_progress",
		"identity_unresolved",
		"recovery_pending",
		"rebaseline_required",
		"device_decommissioned",
		"streaming_active",
	]);
	return known.has(token)
		? `network.modem.gps.error.${token}`
		: "network.modem.gps.error.read_failed";
}
