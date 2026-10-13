import { lstatSync } from "node:fs";
import type { LifecycleState } from "@ceraui/rpc/schemas";
import { otaStreamingMarkerPath } from "../streaming/ota-streaming-marker.ts";
import { getStreamLifecycleState } from "../streaming/stream-lifecycle-status.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import type { StreamLiveness } from "./disruptive-action-gate.ts";
import { isStreamReconciliationCompleted } from "./stream-reconciliation-latch.ts";

export type StreamLivenessEvidence = {
	readonly reconciled: boolean;
	readonly live: boolean;
	readonly lifecycle: LifecycleState;
	readonly sentinel: "present" | "absent" | "unknown";
};

// Default composition until lane B-core's factory accessor lands: swapping
// that accessor in is a change to this file only, never to consumer policy.
// The lifecycle projection is the session owner's own transition write
// (stream-session-production wires setLifecycleState); reading it, not the
// orchestrator module, keeps this adapter out of the update import cycle.
// Idle needs every source to agree. Every idle commit removes the OTA sentinel,
// so a sentinel still present beside an idle projection means that removal
// failed or a start is protecting itself: the two authorities disagree, which
// is unknown. A sentinel that cannot be read is unknown too, never absent.
export function deriveStreamLiveness(
	evidence: StreamLivenessEvidence,
): StreamLiveness {
	if (evidence.live) return "streaming";
	const confirmedIdle = evidence.reconciled && evidence.lifecycle === "idle";
	return confirmedIdle && evidence.sentinel === "absent" ? "idle" : "unknown";
}

let testSource: (() => StreamLiveness) | undefined;

function readSentinel(): StreamLivenessEvidence["sentinel"] {
	try {
		lstatSync(otaStreamingMarkerPath());
		return "present";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "absent"
			: "unknown";
	}
}

export function getStreamLiveness(): StreamLiveness {
	if (testSource) return testSource();
	return deriveStreamLiveness({
		reconciled: isStreamReconciliationCompleted(),
		live: getIsStreaming(),
		lifecycle: getStreamLifecycleState(),
		sentinel: readSentinel(),
	});
}

export function isStreamConfirmedIdle(): boolean {
	return getStreamLiveness() === "idle";
}

export function setStreamLivenessSourceForTest(
	source: (() => StreamLiveness) | null,
): void {
	testSource = source ?? undefined;
}
