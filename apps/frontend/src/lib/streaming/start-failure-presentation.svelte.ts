import { tick } from "svelte";

let awaitingReply = $state(0);
const presented: string[] = [];

// The engine sends its notice before the RPC can return the same attempt ID.
// Keep the notice as a fallback if the RPC fails or Live no longer owns it.
export function holdStartFailureNotice(): () => Promise<void> {
	awaitingReply += 1;
	return async () => {
		await tick();
		awaitingReply -= 1;
	};
}

export function startFailureNoticePending(): boolean {
	return awaitingReply !== 0;
}

export function claimStartFailurePresentation(attemptId: string): boolean {
	if (presented.includes(attemptId)) return false;
	if (presented.length === 64) presented.shift();
	presented.push(attemptId);
	return true;
}
