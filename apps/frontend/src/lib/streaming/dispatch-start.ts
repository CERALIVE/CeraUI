import type { ConfigMessage } from "@ceraui/rpc/schemas";
import { startStreaming } from "$lib/helpers/SystemHelper";
import { NotSentError } from "$lib/rpc/rpc-error";
import { getLinkEpoch } from "$lib/rpc/session-epoch.svelte";
import {
	getStreamingAttemptGeneration,
	getStreamingOptimismState,
	revertStreamingOptimism,
	revertStreamingOptimismFailure,
	startStreamingOptimism,
	supersedeStartingOptimism,
} from "$lib/rpc/streaming-optimism.svelte";
import { getIsStreaming } from "$lib/rpc/subscriptions.svelte";
import {
	clearStartRetry,
	holdStartFailureNotice,
	recordStartRetry,
	releaseStartFailureNotice,
} from "./start-failure-presentation.svelte";
import { noteLostStartReply } from "./unresolved-stream-actions.svelte";

type StartEffects = {
	readonly beforeSend: () => void;
	readonly onRefused: (id: string) => void;
	readonly retry?: {
		readonly onSent: () => void;
		readonly onBlocked?: (() => void) | undefined;
	};
};

/** Own the attempt and correlate its reply with any device notice. */
export async function dispatchStart(
	readmit: () => ConfigMessage | undefined,
	effects?: StartEffects,
) {
	// Optimistic transient: show `starting` immediately, and capture THIS attempt's
	// generation so a late reply from a superseded attempt cannot clobber a newer
	// one (Todo 29 generation identity).
	const link = getLinkEpoch();
	const retry = effects?.retry;
	let attempt: number | undefined;
	const begin = () => {
		startStreamingOptimism();
		attempt = getStreamingAttemptGeneration();
		holdStartFailureNotice();
		return attempt;
	};
	if (!retry) begin();

	try {
		const startResult = await startStreaming(
			() => {
				if (
					getLinkEpoch() !== link ||
					(attempt !== undefined &&
						(getStreamingAttemptGeneration() !== attempt ||
							getStreamingOptimismState() !== "starting"))
				)
					return undefined;
				const config = readmit();
				if (config) effects?.beforeSend();
				return config;
			},
			retry &&
				(() => {
					recordStartRetry(begin());
					retry.onSent();
				}),
		);
		if (attempt === undefined) {
			retry?.onBlocked?.();
			return;
		}
		if (startResult === undefined) {
			supersedeStartingOptimism(attempt);
			return;
		}
		if (getIsStreaming()) return;
		if (!startResult.success) {
			if ("failure" in startResult && startResult.failure) {
				if (attempt === getStreamingAttemptGeneration())
					effects?.onRefused(startResult.failure.attemptId);
				revertStreamingOptimismFailure(startResult.failure, attempt);
			} else {
				revertStreamingOptimism(startResult.error ?? "unknown_error", attempt);
			}
		}
	} catch (error) {
		if (attempt === undefined) {
			retry?.onBlocked?.();
			return;
		}
		// Only proven non-dispatch permits a retry; losing a reply proves no idle.
		if (!(error instanceof NotSentError)) {
			noteLostStartReply(attempt);
			return;
		}
		// The socket refused dispatch, so this attempt cannot have started.
		const reason = error instanceof Error ? error.message : "unknown_error";
		clearStartRetry(attempt);
		revertStreamingOptimism(reason, attempt);
	} finally {
		if (attempt !== undefined) void releaseStartFailureNotice();
	}
}
