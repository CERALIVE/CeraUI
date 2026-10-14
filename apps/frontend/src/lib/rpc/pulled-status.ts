import { rpc } from "./client";
import {
	dispatchEvidence,
	getLinkEpoch,
	statusFrameIsCurrent,
} from "./session-epoch.svelte";
import {
	type ReceivedStatus,
	receivePulledStatus,
} from "./subscriptions.svelte";

/** One supersession permits one fresh read, never a recursive recovery loop. */
export async function pullStatusEvidence(
	isCurrent: () => boolean = () => true,
): Promise<ReceivedStatus | undefined> {
	for (let reads = 0; reads < 2; reads += 1) {
		if (!isCurrent()) return undefined;
		const dispatch = dispatchEvidence();
		const answer = receivePulledStatus(await rpc.status.getStatus(), dispatch);
		if (!isCurrent() || dispatch.link !== getLinkEpoch()) return undefined;
		if (statusFrameIsCurrent(answer.receipt)) return answer;
	}
	return undefined;
}
