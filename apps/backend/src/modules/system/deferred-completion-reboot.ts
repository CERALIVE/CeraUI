import { logger } from "../../helpers/logger.ts";
import {
	isDisruptiveActionPending,
	isPositiveDisruptiveFailure,
	readDisruptiveUpdateBusy,
	reservePowerAction,
} from "./disruptive-action-reservation.ts";
import {
	disruptiveShutdownSignal,
	retryDisruptiveEvidence,
} from "./disruptive-retry.ts";

let cancelDeferred: (() => void) | undefined;
// The ONE shared gate. It imports software-updates, which imports this module,
// so it is bound after evaluation; until then a completion reboot defers.
let sharedDecision:
	| typeof import("./disruptive-action-runtime.ts").getDisruptiveActionDecision
	| undefined;
void import("./disruptive-action-runtime.ts").then(
	(module) => {
		sharedDecision = module.getDisruptiveActionDecision;
	},
	(error: unknown) => {
		logger.error("Completion reboot gate failed to load", { error });
	},
);

export function requestCompletionReboot(run: () => void | Promise<void>): void {
	if (disruptiveShutdownSignal().aborted || cancelDeferred) return;
	const submit = () => {
		if (isDisruptiveActionPending()) return false;
		// The one shared gate: stream, orchestrator, package install, recovery and
		// maintenance. Called without a power action so a pending hold is never
		// superseded; the deferral below simply retries. Until the orchestrator
		// has registered its busy source, the default reads as busy: refuse.
		if (!sharedDecision || readDisruptiveUpdateBusy().length > 0) return false;
		const admission = reservePowerAction(sharedDecision(), "reboot");
		if (!admission.allowed) return false;
		const failed = (error: unknown) => {
			if (isPositiveDisruptiveFailure(error))
				admission.reservation.releaseAfterFailure();
			logger.error("Software update reboot submission failed", { error });
		};
		try {
			const completion = run();
			if (completion)
				void completion.then(
					admission.reservation.releaseAfterCompletion,
					failed,
				);
			else admission.reservation.releaseAfterCompletion();
		} catch (error) {
			failed(error);
		}
		return true;
	};
	if (submit()) return;
	cancelDeferred = retryDisruptiveEvidence(async () => {
		if (!submit()) return false;
		cancelDeferred = undefined;
		return true;
	});
}

export function resetCompletionRebootForTest(): void {
	cancelDeferred?.();
	cancelDeferred = undefined;
}
