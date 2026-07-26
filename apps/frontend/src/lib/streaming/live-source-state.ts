/**
 * live-source-state — the mid-stream source verdict, shared by the alert that
 * reports a lost source and the card that offers a way out of it.
 *
 * These two used to be derived independently in LiveCockpit and LiveSourceSwitch,
 * and they drifted: after a device re-enumerated mid-stream the alert stayed up
 * (its id resolved to no row) while the switch card's capture-origin gate stopped
 * matching and it unmounted — so the banner told the operator to "switch to
 * another source to keep your stream alive" with nothing left to switch with.
 * One verdict, two consumers, so they cannot disagree again.
 *
 * Pure and rune-free, like `go-live-readiness.ts` and `coarse-source-hint.ts`.
 */
import type { StreamSource } from "@ceraui/rpc/schemas";

import { findSourceById } from "./sourceSummary";

export interface LiveSourceStateInput {
	/** Engine `active_encode.active_input` — wins over the persisted id. */
	activeInput: string | undefined;
	/** Persisted `config.source`. */
	configSource: string | undefined;
	/** The unified `sources` broadcast rows (undefined before the first frame). */
	sources: readonly StreamSource[] | undefined;
	isStreaming: boolean;
	/** The post-stream summary window — every live verdict is suppressed in it. */
	summaryMode: boolean;
}

export interface LiveSourceState {
	runningId: string | undefined;
	runningSource: StreamSource | undefined;
	/** Drives the `active-source-lost-banner`. */
	sourceLost: boolean;
}

export function deriveLiveSourceState(
	input: LiveSourceStateInput,
): LiveSourceState {
	const runningId = input.activeInput ?? input.configSource;
	const runningSource = findSourceById(runningId, input.sources);
	const sourceLost =
		input.isStreaming &&
		!input.summaryMode &&
		runningId !== undefined &&
		// An empty list is the pre-first-broadcast state, not a loss.
		(input.sources?.length ?? 0) > 0 &&
		(runningSource === undefined || runningSource.lost === true);
	return { runningId, runningSource, sourceLost };
}

/**
 * Whether the live Switch-source card may render.
 *
 * `sourceLost` opens the gate on its own: a running id that resolves to no row
 * can never satisfy the capture-origin test, and that is precisely the state the
 * alert tells the operator to act on. Below two capture sources there is still
 * nothing to switch between, so the card stays down and the alert stands alone.
 */
export function canOfferLiveSourceSwitch(
	runningSource: StreamSource | undefined,
	captureSourceCount: number,
	sourceLost: boolean,
): boolean {
	if (captureSourceCount < 2) return false;
	return runningSource?.origin === "capture" || sourceLost;
}
