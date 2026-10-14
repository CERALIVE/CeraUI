/**
 * The ONE retry owner of the modem-mutation admission barrier.
 *
 * The barrier may only be lowered by a COMPLETE, readable look at the journal.
 * Before this owner existed nothing ever looked again: one EIO while startup
 * listed the journal left every later modem mutation answering
 * `recovery_pending` ("ask again shortly") forever, and kept stream restoration
 * and autostart waiting on a barrier nobody would lower.
 *
 *   - `replay` mode is the startup replay retried. It is safe to repeat because
 *     the barrier has been raised since boot, so no mutation was admitted that a
 *     rollback could race. A lost replay fence is incomplete, not a blocked
 *     entry: retry rereads the slot and recaptures the hardware pre-state. The
 *     already-restored guard avoids resubmitting a successful rollback.
 *   - `verify` mode follows a RUNTIME raise (a journal read failed after replay
 *     had completed). A mutation admitted before that raise may still be running,
 *     so this mode never rolls anything back: it only re-reads the inventory and
 *     the per-identity blocks, and lowers the barrier when both read completely.
 *
 * Backoff doubles from 1 s to a 60 s ceiling, and the loop runs until success or
 * until shutdown cancels it.
 */

import { logger } from "../../helpers/logger.ts";
import {
	completeRecoveryBarrier,
	consumeRecoveryBarrierRaise,
	isRecoveryPending,
} from "../streaming/recovery-barrier.ts";
import { reconciledMutationJournalRevision } from "./mutation-blocks.ts";
import {
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";

export type MutationRecoveryMode = "replay" | "verify";

export interface MutationRecoveryDeps {
	/** Full startup replay; true when every slot settled without lost authority. */
	readonly replay: () => Promise<boolean>;
	/** Read-only inventory; true when the journal and blocks read completely. */
	readonly verify: () => Promise<boolean>;
	/** Resolves after `ms`, or early once `signal` aborts. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const MUTATION_RECOVERY_BASE_MS = 1000;
export const MUTATION_RECOVERY_CEILING_MS = 60_000;

let running: AbortController | undefined;
let stopped = false;

export function sleepUnlessAborted(
	ms: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

async function attempt(
	deps: MutationRecoveryDeps,
	mode: MutationRecoveryMode,
): Promise<boolean> {
	try {
		return mode === "replay" ? await deps.replay() : await deps.verify();
	} catch (err) {
		logger.error("modem mutation recovery attempt failed", {
			module: "modems",
			mode,
			err,
		});
		return false;
	}
}

async function retry(
	deps: MutationRecoveryDeps,
	mode: MutationRecoveryMode,
	own: AbortController,
): Promise<void> {
	try {
		for (let delay = MUTATION_RECOVERY_BASE_MS; ; ) {
			await deps.sleep(delay, own.signal);
			if (own.signal.aborted || !isRecoveryPending()) return;
			consumeRecoveryBarrierRaise();
			const revision = mutationJournalRevision();
			if (await attempt(deps, mode)) {
				const finalRevision =
					mode === "replay" ? reconciledMutationJournalRevision() : revision;
				if (own.signal.aborted) return;
				if (
					isMutationJournalRevisionCurrent(finalRevision) &&
					completeRecoveryBarrier()
				)
					return;
			}
			logger.warn(
				"modem mutation journal reconciliation incomplete; retrying",
				{
					module: "modems",
					mode,
					nextMs: Math.min(delay * 2, MUTATION_RECOVERY_CEILING_MS),
				},
			);
			delay = Math.min(delay * 2, MUTATION_RECOVERY_CEILING_MS);
		}
	} finally {
		if (running === own) running = undefined;
	}
}

/** Start the owner unless one is already running; it never runs twice. */
export function scheduleMutationRecovery(
	deps: MutationRecoveryDeps,
	mode: MutationRecoveryMode,
): void {
	if (stopped || running !== undefined) return;
	const own = new AbortController();
	running = own;
	void retry(deps, mode, own);
}

export function stopMutationRecovery(): void {
	stopped = true;
	running?.abort();
	running = undefined;
}

export function startMutationRecovery(): void {
	stopped = false;
}
