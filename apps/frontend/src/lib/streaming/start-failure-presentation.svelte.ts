import { tick } from "svelte";

let awaitingReply = $state(0);
const presented: string[] = [];
const RETRY_WINDOW_MS = 120_000;
let retry: { readonly generation: number; readonly at: number } | undefined;

export function recordStartRetry(generation: number): void {
	retry = { generation, at: performance.now() };
}

export function clearStartRetry(generation?: number): void {
	if (generation === undefined || retry?.generation === generation)
		retry = undefined;
}

export function consumeStartRetry(generation: number): boolean {
	const repeated =
		retry?.generation === generation &&
		performance.now() - retry.at < RETRY_WINDOW_MS;
	clearStartRetry();
	return repeated;
}

// The engine sends its notice before the RPC can return the same attempt ID.
// Keep the notice as a fallback if the RPC fails or Live no longer owns it.
export function holdStartFailureNotice(): void {
	awaitingReply += 1;
}

export async function releaseStartFailureNotice(): Promise<void> {
	await tick();
	awaitingReply -= 1;
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
