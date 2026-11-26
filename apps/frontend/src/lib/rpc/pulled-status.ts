import { rpc } from "./client";
import {
	dispatchEvidence,
	getLinkEpoch,
	statusFrameIsCurrent,
} from "./session-epoch.svelte";
import {
	ingestPulledStatus,
	type ReceivedStatus,
	receivePulledStatus,
} from "./subscriptions.svelte";

/** By default, one supersession permits one fresh read. */
export async function pullStatusEvidence(
	isCurrent: () => boolean = () => true,
	{
		retryOnSupersession = true,
	}: { readonly retryOnSupersession?: boolean } = {},
): Promise<ReceivedStatus | undefined> {
	const readLimit = retryOnSupersession ? 2 : 1;
	for (let reads = 0; reads < readLimit; reads += 1) {
		if (!isCurrent()) return undefined;
		const dispatch = dispatchEvidence();
		const answer = receivePulledStatus(await rpc.status.getStatus(), dispatch);
		if (!isCurrent() || dispatch.link !== getLinkEpoch()) return undefined;
		if (statusFrameIsCurrent(answer.receipt)) return answer;
		// Stream supersession withholds settlement, not disjoint hydration.
		ingestPulledStatus(answer.status, answer.receipt);
	}
	return undefined;
}
