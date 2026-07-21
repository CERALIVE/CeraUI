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

// Mid-stream lifecycle indicators (Todo 20).
//
// Four highest-value "something broke WHILE you're live" signals that were
// previously silent on the device path:
//
//   1. active video source disconnected mid-stream (devices.ts hotplug)
//   2. active audio device vanished mid-stream (audio watcher; the stream keeps
//      running in SILENCE — never a test tone, per Todo 17's failover semantics)
//   3. all bonded links down mid-stream (0 active of N>0, from the truthful
//      srtla link telemetry Todo 19 made honest)
//   4. streaming engine crashed / recovered (the control socket dropped while
//      streaming; the engine-reconnect loop + the passthrough bridge detect it)
//
// Each indicator is EMIT-ON-TRANSITION: entering the bad state raises ONE
// persistent error notification (deduped by name — a repeated "still bad" report
// never re-toasts); recovering removes that persistent notification and raises a
// single transient "recovered" toast. A stream stop clears any lingering
// indicator SILENTLY (no false "recovered" toast — the stream ended, it did not
// heal). Every effectful surface (notify / removeNotification) is injected so the
// transition machine is exercisable fixture-driven with no real broadcast.

import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";

/** The four indicator identities. Notification NAME == the persistent key. */
export type LifecycleIndicator =
	| "active-source-lost"
	| "active-audio-lost"
	| "all-links-down"
	| "engine-crashed";

interface IndicatorCopy {
	/** Persistent error copy shown while the bad state holds. */
	lostKey: string;
	lostMsg: string;
	/** Transient success copy shown once on recovery. */
	recoveredKey: string;
	recoveredMsg: string;
}

/**
 * Per-indicator copy. `*Key` is the typesafe-i18n dotted path the frontend toast
 * host resolves via `$LL`; `*Msg` is the English wire fallback used when no
 * translation leaf exists. The audio copy deliberately names the SILENCE failover
 * (Todo 17) — the stream keeps running muted, never a beep.
 */
const INDICATOR_COPY: Record<LifecycleIndicator, IndicatorCopy> = {
	"active-source-lost": {
		lostKey: "notifications.activeSourceLost",
		lostMsg:
			"The video source you're streaming was lost. Reconnect it, or switch to another source to keep your stream alive.",
		recoveredKey: "notifications.activeSourceRecovered",
		recoveredMsg: "Video source reconnected.",
	},
	"active-audio-lost": {
		lostKey: "notifications.activeAudioLost",
		lostMsg:
			"The audio device you're streaming was lost. Your stream continues in silence until it's reconnected.",
		recoveredKey: "notifications.activeAudioRecovered",
		recoveredMsg: "Audio device reconnected. Sound is back.",
	},
	"all-links-down": {
		lostKey: "notifications.allLinksDown",
		lostMsg:
			"All bonded links are down. Your stream can't send data until a link recovers.",
		recoveredKey: "notifications.linksRecovered",
		recoveredMsg: "Bonded links recovered.",
	},
	"engine-crashed": {
		lostKey: "notifications.engineCrashed",
		lostMsg: "The streaming engine stopped unexpectedly. Recovering\u2026",
		recoveredKey: "notifications.engineRecovered",
		recoveredMsg: "The streaming engine recovered.",
	},
};

/** Injected effectful surface (defaults wire the real broadcast path). */
export interface LifecycleIndicatorDeps {
	notify: typeof notificationBroadcast;
	removeNotification: typeof notificationRemove;
}

function defaultDeps(): LifecycleIndicatorDeps {
	return {
		notify: notificationBroadcast,
		removeNotification: notificationRemove,
	};
}

let indicatorDeps: LifecycleIndicatorDeps = defaultDeps();

/**
 * Test seam: swap the notify/remove surface (null restores production wiring).
 * Also clears all transition state so a suite starts from a clean slate.
 */
export function setLifecycleIndicatorDepsForTest(
	deps: LifecycleIndicatorDeps | null,
): void {
	indicatorDeps = deps ?? defaultDeps();
	indicatorStates.clear();
}

/** Drop all transition state (per-test isolation; also used on a fresh start). */
export function resetLifecycleIndicatorState(): void {
	indicatorStates.clear();
}

type IndicatorState = "ok" | "bad";

// Process-wide transition state. Absent == "ok" (never emitted). Only an EDGE
// (ok→bad or bad→ok) emits, which is exactly the dedupe contract.
const indicatorStates = new Map<LifecycleIndicator, IndicatorState>();

/**
 * Core emit-on-transition machine. `isStreaming` gates every indicator — an
 * indicator only fires while a stream is requested. When not streaming, a
 * lingering bad state is cleared SILENTLY (the stream ended, it did not recover).
 *
 * Returns the action taken (`"lost" | "recovered" | "cleared" | "none"`) purely
 * so tests can assert the edge without inspecting the notify spy.
 */
export function evaluateIndicator(
	indicator: LifecycleIndicator,
	isStreaming: boolean,
	isBad: boolean,
	deps: LifecycleIndicatorDeps = indicatorDeps,
): "lost" | "recovered" | "cleared" | "none" {
	const prev = indicatorStates.get(indicator) ?? "ok";

	if (!isStreaming) {
		// Not streaming: a bad indicator from a prior stream is cleared without a
		// recovered toast (the stream stopped — nothing "recovered").
		if (prev !== "ok") {
			indicatorStates.set(indicator, "ok");
			deps.removeNotification(indicator);
			return "cleared";
		}
		return "none";
	}

	const next: IndicatorState = isBad ? "bad" : "ok";
	if (next === prev) return "none"; // dedupe: only edges emit

	indicatorStates.set(indicator, next);
	const copy = INDICATOR_COPY[indicator];

	if (next === "bad") {
		// Persistent, non-dismissable error toast; duration 0 = never auto-expires.
		deps.notify(
			indicator,
			"error",
			copy.lostMsg,
			0,
			true,
			false,
			true,
			copy.lostKey,
		);
		return "lost";
	}

	// Recovered: drop the persistent error, then a transient success toast.
	deps.removeNotification(indicator);
	deps.notify(
		`${indicator}-recovered`,
		"success",
		copy.recoveredMsg,
		5,
		false,
		true,
		true,
		copy.recoveredKey,
	);
	return "recovered";
}

/**
 * Indicator 1 — active video source disconnected mid-stream. Bad iff the applied
 * source id is set, the device set has been reported (non-empty — an empty list
 * is the pre-first-scan state, not a loss), and the applied id is absent from it.
 */
export function reportActiveVideoSource(p: {
	isStreaming: boolean;
	activeSourceId: string | undefined;
	presentSourceIds: readonly string[];
}): void {
	const bad =
		p.activeSourceId !== undefined &&
		p.presentSourceIds.length > 0 &&
		!p.presentSourceIds.includes(p.activeSourceId);
	evaluateIndicator("active-source-lost", p.isStreaming, bad);
}

/**
 * Indicator 2 — active audio device vanished mid-stream. The caller (audio.ts)
 * owns the pseudo/auto-source knowledge and passes the resolved `isDeviceLost`
 * verdict; this keeps the module free of the audio device-map vocabulary.
 */
export function reportActiveAudioSource(p: {
	isStreaming: boolean;
	isDeviceLost: boolean;
}): void {
	evaluateIndicator("active-audio-lost", p.isStreaming, p.isDeviceLost);
}

/**
 * Indicator 3 — all bonded links down mid-stream. Bad iff at least one link is
 * configured (`linkCount > 0`) and none of them are active. A partial drop
 * (`0 < activeLinks < linkCount`) is the health module's "degraded" reason, NOT
 * this distinct all-down banner.
 */
export function reportAllLinksDown(p: {
	isStreaming: boolean;
	linkCount: number;
	activeLinks: number;
}): void {
	const bad = p.linkCount > 0 && p.activeLinks === 0;
	evaluateIndicator("all-links-down", p.isStreaming, bad);
}

/**
 * Indicator 4 — streaming engine crashed / recovered. Bad iff the engine control
 * socket is unreachable while streaming. Driven both by the engine-reconnect loop
 * (boot / periodic recheck transitions) and by the passthrough bridge's live
 * socket close/reconnect (the real-time mid-stream detector).
 */
export function reportEngineState(p: {
	isStreaming: boolean;
	reachable: boolean;
}): void {
	evaluateIndicator("engine-crashed", p.isStreaming, !p.reachable);
}
