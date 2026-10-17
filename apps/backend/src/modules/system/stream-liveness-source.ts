import type { LifecycleState } from "@ceraui/rpc/schemas";
import { getStreamLifecycleState } from "../streaming/stream-lifecycle-status.ts";
import { streamLiveness } from "../streaming/stream-liveness.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import type { StreamLiveness } from "./disruptive-action-gate.ts";
import { isStreamReconciliationCompleted } from "./stream-reconciliation-latch.ts";

export type StreamLivenessEvidence = {
	readonly reconciled: boolean;
	readonly live: boolean;
	readonly lifecycle: LifecycleState;
	readonly sentinel: "present" | "absent" | "unknown";
};

// The owner's published lifecycle can withhold leaf idle, never grant it.
export function deriveStreamLiveness(
	evidence: StreamLivenessEvidence,
): StreamLiveness {
	if (evidence.live) return "streaming";
	const confirmedIdle = evidence.reconciled && evidence.lifecycle === "idle";
	return confirmedIdle && evidence.sentinel === "absent" ? "idle" : "unknown";
}

let testSource: (() => StreamLiveness) | undefined;

export function getStreamLiveness(): StreamLiveness {
	if (testSource) return testSource();
	const leaf = streamLiveness();
	return deriveStreamLiveness({
		reconciled: isStreamReconciliationCompleted(),
		live: getIsStreaming() || leaf === "streaming",
		lifecycle: getStreamLifecycleState(),
		sentinel: leaf === "idle" ? "absent" : "unknown",
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
