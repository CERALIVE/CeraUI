import { logger } from "../../helpers/logger.ts";
import { decideDisruptiveAction } from "./disruptive-action-gate.ts";
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
import { isSoftwareUpdateRecoveryInconclusive } from "./software-update-recovery.ts";
import { getStreamLiveness } from "./stream-liveness-source.ts";

let cancelDeferred: (() => void) | undefined;

export function requestCompletionReboot(run: () => void | Promise<void>): void {
	if (disruptiveShutdownSignal().aborted || cancelDeferred) return;
	const submit = () => {
		if (isDisruptiveActionPending()) return false;
		const admission = reservePowerAction(
			decideDisruptiveAction({
				streamLiveness: getStreamLiveness(),
				updateBusy: [
					...readDisruptiveUpdateBusy(),
					...(isSoftwareUpdateRecoveryInconclusive()
						? ["update-recovery" as const]
						: []),
				],
			}),
			"reboot",
		);
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
