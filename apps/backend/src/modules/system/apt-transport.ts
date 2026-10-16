import {
	SpawnAbortError,
	SpawnTimeoutError,
} from "../../helpers/bounded-spawn.ts";
import { logger } from "../../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import type { AptReachability } from "./apt-reachability.ts";
import {
	type AptRoutingOwnership,
	AptRoutingRefusal,
	aptRoutingOwnership,
} from "./apt-routing-ownership.ts";
import {
	type AptTransferAdmission,
	captureAptTransferAdmission,
	trackAptTransfer,
} from "./apt-transfer-abort.ts";
import {
	aptCommandFailure,
	classifyAptFetchFailure,
	familyName,
	forced,
	normalizeAptCommandFailure,
	reachabilityFromSelection,
} from "./apt-transport-result.ts";
import { isStreamConfirmedIdle } from "./stream-liveness-source.ts";
import type { TransportSelection } from "./update-transport/core.ts";

export {
	classifyAptFetchFailure,
	reachabilityFromSelection,
} from "./apt-transport-result.ts";

import { selectUpdateTransport } from "./update-transport/executor.ts";
import {
	UpdatePinError,
	UpdateTransferError,
	updatePinController,
} from "./update-transport/pin.ts";

/** One networked apt run; `reachability.verdict` is this attempt's pinned family. */
export type AptStep = (
	reachability: AptReachability,
	signal?: AbortSignal,
) => Promise<SpawnWithTimeoutResult>;

/**
 * One APT transaction's network authority. A legacy transaction is today's
 * unbound family verdict; a pinned one routes the `apt_uid` sandbox user
 * (apt's fetch methods) through the selected uplink and family.
 */
export type AptTransaction = {
	readonly pinned: boolean;
	readonly reachability: AptReachability;
	/** Local apt work under the winner's rule; `refused` answers a routing refusal. */
	readonly within: <T>(
		work: (attempt: AptReachability) => Promise<T>,
		refused: () => T,
	) => Promise<T>;
	/** A networked apt run; an apt fetch failure fails over to the next pair. */
	readonly transfer: (
		step: AptStep,
		options?: { readonly abortable?: boolean },
	) => Promise<SpawnWithTimeoutResult>;
	readonly aborted: () => boolean;
};

class AptTransferAborted extends Error {
	constructor() {
		super("apt transfer aborted for a stream start");
		this.name = "AptTransferAborted";
	}
}

export type AptTransportDeps = {
	readonly isIdle: () => boolean;
	readonly ownership: AptRoutingOwnership;
	readonly select: () => Promise<TransportSelection>;
	readonly pin: Pick<typeof updatePinController, "run">;
};

let overrides: Partial<AptTransportDeps> = {};

export function setAptTransportDepsForTest(
	next: Partial<AptTransportDeps> | null,
): void {
	overrides = next ?? {};
}

// Resolved per call: reading `updatePinController` at module load trips an import cycle.
const pinController = () => overrides.pin ?? updatePinController;
const select = () =>
	overrides.select?.() ??
	// The APT profile never names an images.ceralive.tv object, so board and channel are inert.
	selectUpdateTransport({ profile: "apt", board: "apt", channel: "stable" });

const refusedRun = (error: Error): SpawnWithTimeoutResult => ({
	exitCode: 1,
	stdout: "",
	stderr: error.message,
});

function isRoutingRefusal(error: unknown): error is Error {
	return (
		error instanceof UpdatePinError ||
		error instanceof AptRoutingRefusal ||
		error instanceof AggregateError ||
		error instanceof AptTransferAborted
	);
}

export function legacyAptTransaction(
	reachability: AptReachability,
): AptTransaction {
	return {
		pinned: false,
		reachability,
		within: (work) => work(reachability),
		transfer: (step) => step(reachability),
		aborted: () => false,
	};
}

/** Probe every (uplink, family), then pin each apt run to the ranked winner. */
export async function openPinnedAptTransaction(
	admission: AptTransferAdmission = captureAptTransferAdmission(),
): Promise<AptTransaction> {
	let selection: TransportSelection;
	try {
		selection = await select();
	} catch (error) {
		logger.warn("APT transport selection failed", { error });
		return legacyAptTransaction({
			ipv4: "probe_unavailable",
			ipv6: "probe_unavailable",
			used: "none",
			verdict: "probe_unavailable",
			detail: [],
		});
	}
	const controller = new AbortController();
	const cancelled = () => {
		if (admission.cancelled()) controller.abort();
		if (controller.signal.aborted) throw new AptTransferAborted();
	};
	let reachability = reachabilityFromSelection(selection);
	return {
		pinned: true,
		get reachability() {
			return reachability;
		},
		aborted: () => controller.signal.aborted || admission.cancelled(),
		async within(work, refused) {
			// With no winner the verdict already refuses every networked step; local work stays local.
			if (selection.status === "none") return work(reachability);
			try {
				// Box the outcome so an arbitrary coded error is never mistaken for a transfer failure.
				const boxed = await pinController().run(
					"apt",
					selection,
					async ({ family }) => {
						reachability = {
							...reachability,
							verdict: forced(family),
							used: familyName(family),
						};
						try {
							return { ok: true as const, value: await work(reachability) };
						} catch (error) {
							return { ok: false as const, error };
						}
					},
					{ aptOwnership: overrides.ownership ?? aptRoutingOwnership },
				);
				if (!boxed.ok) throw boxed.error;
				return boxed.value;
			} catch (error) {
				if (!isRoutingRefusal(error)) throw error;
				logger.warn("APT transaction refused by update routing", { error });
				return refused();
			}
		},
		async transfer(step, options = {}) {
			let last: SpawnWithTimeoutResult | undefined;
			const release = options.abortable
				? trackAptTransfer(controller, admission)
				: () => undefined;
			try {
				return await pinController().run(
					"apt",
					selection,
					async ({ family }) => {
						reachability = {
							...reachability,
							verdict: forced(family),
							used: familyName(family),
						};
						if (
							options.abortable &&
							!(overrides.isIdle ?? isStreamConfirmedIdle)()
						)
							controller.abort();
						cancelled();
						try {
							last = await step(
								{
									...reachability,
									verdict: forced(family),
									used: familyName(family),
								},
								options.abortable ? controller.signal : undefined,
							);
						} catch (error) {
							if (!(error instanceof SpawnTimeoutError)) throw error;
							last = normalizeAptCommandFailure(error);
						}
						const failure = aptCommandFailure(last);
						if (failure instanceof SpawnAbortError) controller.abort();
						cancelled();
						const reason = classifyAptFetchFailure(last);
						if (failure)
							last = {
								exitCode: last.exitCode,
								stdout: failure.partialStdout,
								stderr: failure.partialStderr || failure.message,
							};
						if (reason) throw new UpdateTransferError(reason);
						return last;
					},
					{
						checkCancelled: cancelled,
						aptOwnership: overrides.ownership ?? aptRoutingOwnership,
					},
				);
			} catch (error) {
				if (error instanceof UpdateTransferError && last) return last;
				if (!isRoutingRefusal(error)) throw error;
				logger.warn("APT transfer refused by update routing", { error });
				return refusedRun(error);
			} finally {
				release();
			}
		},
	};
}
