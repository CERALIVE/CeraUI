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
 * The degraded-SELECTED capture snapshot (wave-4 todo 21d).
 *
 * cerastream's capture-resilience layer reports that the operator's OWN selected
 * capture leg came up degraded. It is NOT a distinct wire event — `grep
 * capture_degraded` across the published `@ceralive/cerastream` bindings returns
 * nothing, because the engine emits it as the EXISTING `capture_video_error`
 * runtime error additionally carrying `selected: true`.
 *
 * That matters for how it is retracted. `capture_video_error` already has an
 * engine-authored recovery signal and a single clearing seam in
 * `cerastream-backend.ts` (`ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION` +
 * `clearRecoveredEngineError`). This snapshot INHERITS that seam verbatim and
 * deliberately grows no clearing path of its own — a second, independently-timed
 * retraction is precisely how the two halves of a raise/clear pair drift apart.
 *
 * It is a persistent SNAPSHOT rather than a one-shot notification because a
 * backend restart or a frontend reconnect must not lose the state: CeraUI today
 * maps engine errors only onto notifications, which a client that connects
 * afterwards never sees. It rides the `sources` payload so the state arrives
 * with the row it is about.
 */

import type { SourceDegraded } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

/** The standing snapshot: WHICH device, and WHAT the engine said about it. */
export interface CaptureDegradedSnapshot {
	/** The engine `input_id` the selection resolved to when the report arrived. */
	sourceId: string | undefined;
	/** Its stable hardware identity, so a renumber does not strand the snapshot. */
	stableId: string | undefined;
	state: SourceDegraded;
}

let snapshot: CaptureDegradedSnapshot | undefined;

/**
 * Re-publish `sources` after the snapshot moved.
 *
 * Owned HERE rather than by the engine backend that raises it, because
 * `cerastream-backend.ts` is pinned by a regression test to never name
 * `./sources.ts` at all — the start choke point must stay isolated from the
 * source builder. The import is dynamic for the mirror-image reason
 * `sources.ts` uses for `audio.ts`: `sources.ts` imports THIS module
 * statically, so a static import back would cycle.
 */
type CaptureDegradedPublisher = () => void;

const defaultPublisher: CaptureDegradedPublisher = () => {
	void import("./sources.ts")
		.then(({ broadcastSources }) => {
			broadcastSources();
		})
		.catch((err: unknown) => {
			logger.debug("capture-degraded: sources re-publish failed", { err });
		});
};

let publisher: CaptureDegradedPublisher = defaultPublisher;

/** Test seam: swap the re-publisher (`undefined` restores the default). */
export function setCaptureDegradedPublisherForTest(
	fn: CaptureDegradedPublisher | undefined,
): void {
	publisher = fn ?? defaultPublisher;
}

/**
 * Record that the SELECTED capture leg is degraded.
 *
 * The engine names no device — `selected: true` means "the one you chose" — so
 * the identity is bound here, from the selection as it stands at report time.
 */
export function noteSelectedCaptureDegraded(
	report: CaptureDegradedSnapshot,
): void {
	snapshot = report;
	publisher();
}

/** Retract the snapshot. Returns whether anything was actually standing. */
export function clearSelectedCaptureDegraded(): boolean {
	if (snapshot === undefined) return false;
	snapshot = undefined;
	publisher();
	return true;
}

export function getSelectedCaptureDegraded():
	| CaptureDegradedSnapshot
	| undefined {
	return snapshot;
}
