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

/*
 * Selected-but-unbound coarse source: the "did you mean the device below?" rule.
 *
 * A `coarse` StreamSource is a capability PLACEHOLDER — the sources model only
 * keeps one when NO enumerated engine device bridged to its pipeline. It stays
 * selectable (the legacy pipeline-picker behaviour) and honestly renders a
 * "Not connected" pill, so `config.source` can legitimately hold a coarse
 * pipeline id. That combination is a real operator state, NOT a bug.
 *
 * What WAS a bug is how quiet it looked. A live operator report: on an RK3588
 * board the on-board HDMI-RX (`/dev/video0`, `rk_hdmirx`) enumerates under a
 * different pipeline than the coarse `hdmi` placeholder expects, so that row is
 * permanently "Not connected" — yet selecting it painted the SAME lime
 * checkmark + "Selected" as a working device. The operator's actual camera, a
 * RØDE HDMI-to-USB-C adapter, sat one row below under a name they did not
 * recognise as "the HDMI thing". The small "?" popover was too easy to miss.
 *
 * This module is the pure, rune-free rule behind the stronger treatment. It
 * answers ONE question: given the coarse row the operator selected, which
 * CONNECTED capture devices plausibly are what they actually meant? The match is
 * deliberately conservative — a candidate must be live AND its real hardware
 * name must contain the coarse row's own pipeline token (`hdmi`, `usb`, …), so
 * an unrelated camera never produces a false "did you mean" pointer.
 */
import type { CaptureStreamSource, StreamSource } from "@ceraui/rpc/schemas";

/** Cap on rendered suggestions — a hint, never a second source list. */
export const MAX_COARSE_SUGGESTIONS = 3;

/**
 * A capture device is a usable alternative only when it is genuinely reachable
 * right now: the backend has not marked it unavailable and it was not unplugged
 * mid-session. Both flags are consumed as backend truth, never re-derived.
 */
function isLiveCapture(source: StreamSource): source is CaptureStreamSource {
	return (
		source.origin === "capture" &&
		source.available !== false &&
		source.lost !== true
	);
}

/**
 * The token a coarse row is "about" — its pipeline id (`hdmi`, `usb`, `camlink`,
 * …). Matching on this rather than the translated label keeps the rule locale
 * independent: hardware `Card type` strings are ASCII product names, so a
 * translated "HDMI Capture" label would match nothing in, say, Japanese.
 */
function coarseToken(source: StreamSource): string {
	return (source.pipelineId || source.id).toLowerCase();
}

/**
 * The connected capture devices whose REAL hardware name contains the selected
 * coarse row's pipeline token, in broadcast order, capped at
 * {@link MAX_COARSE_SUGGESTIONS}.
 *
 * Returns an empty array for any non-coarse source and whenever nothing
 * plausibly matches — the caller renders no pointer in that case rather than
 * guessing (a wrong "did you mean" is worse than none).
 */
export function suggestedCapturesForCoarse(
	coarse: StreamSource | undefined,
	sources: readonly StreamSource[] | undefined,
): CaptureStreamSource[] {
	if (coarse?.origin !== "coarse" || !sources) return [];
	const token = coarseToken(coarse);
	if (token.length === 0) return [];
	return sources
		.filter(isLiveCapture)
		.filter((device) => device.displayName.toLowerCase().includes(token))
		.slice(0, MAX_COARSE_SUGGESTIONS);
}

/** The rendered state of the selected-but-unbound coarse warning. */
export interface CoarseUnboundState {
	/** The selected row is a coarse placeholder with no device behind it. */
	unbound: boolean;
	/** Connected devices the operator plausibly meant instead (may be empty). */
	suggestions: CaptureStreamSource[];
}

/**
 * Derive the warning state for ONE rendered row. `unbound` is true only for the
 * coarse row that IS the current `config.source` — an unselected coarse row keeps
 * its existing calm muted treatment, and a concrete capture row is never flagged.
 */
export function deriveCoarseUnboundState(
	source: StreamSource,
	selected: boolean,
	sources: readonly StreamSource[] | undefined,
): CoarseUnboundState {
	const unbound = selected && source.origin === "coarse";
	return {
		unbound,
		suggestions: unbound ? suggestedCapturesForCoarse(source, sources) : [],
	};
}
