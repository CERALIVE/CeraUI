import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import type { DisruptiveActionDecision } from "./disruptive-action-gate.ts";
import {
	DisruptiveActionRefusal,
	type DisruptiveReservation,
	isPositiveDisruptiveFailure,
	type PowerAction,
	reserveDisruptiveAction,
	reservePowerAction,
} from "./disruptive-action-reservation.ts";
import {
	disruptiveShutdownSignal,
	retryDisruptiveEvidence,
} from "./disruptive-retry.ts";
import {
	parseOsStageSystemdProperties,
	parseSystemdExitFields,
} from "./update-orchestrator/os-stage-systemd.ts";

export type ServiceCompletion =
	| "in-flight"
	| "unknown"
	| "completed"
	| "failed";
export type ServiceReservationScope = {
	readonly unit: string;
	readonly decision: () => DisruptiveActionDecision;
	readonly owner?: symbol;
	readonly shutdownAction?: PowerAction;
	readonly positiveFailure?: (error: unknown) => boolean;
};
export type ServiceCompletionProbe = (
	scope: ServiceReservationScope,
	signal: AbortSignal,
) => Promise<ServiceCompletion>;

export async function probeServiceCompletion(
	scope: ServiceReservationScope,
	signal: AbortSignal,
): Promise<ServiceCompletion> {
	const reply = await spawnWithTimeout(
		[
			"systemctl",
			"show",
			"--property=Job,ActiveState,SubState,ExecMainCode,ExecMainStatus,Result",
			"--",
			scope.unit,
		],
		{ timeoutMs: 5_000, signal },
	);
	if (reply.exitCode !== 0) return "unknown";
	const rows = parseOsStageSystemdProperties(reply.stdout);
	if (!rows) return "unknown";
	const job = rows.get("Job");
	if (job === undefined) return "unknown";
	if (job !== "" && job !== "0") return "in-flight";
	const active = rows.get("ActiveState");
	const sub = rows.get("SubState");
	const settled =
		(active === "active" && ["running", "exited"].includes(sub ?? "")) ||
		(active === "inactive" && sub === "dead") ||
		(active === "failed" && sub === "failed");
	if (!settled) return "in-flight";
	if (scope.shutdownAction === undefined) return "completed";
	const exit = parseSystemdExitFields(rows);
	if (!exit) return "unknown";
	if (
		exit.mainCode === 1 &&
		exit.mainStatus === 0 &&
		rows.get("Result") === "success"
	)
		return "completed";
	if (exit.mainCode !== 1 || exit.mainStatus !== 0) return "failed";
	return "unknown";
}

function resolveUncertainService(
	reservation: DisruptiveReservation,
	scope: ServiceReservationScope,
	probe: ServiceCompletionProbe,
): void {
	reservation.markUncertain();
	const observe = async (signal: AbortSignal) => {
		if (!reservation.retained() || signal.aborted) return true;
		if (!reservation.active()) return false;
		const result = await probe(scope, signal);
		if (!reservation.retained() || signal.aborted) return true;
		if (!reservation.active()) return false;
		switch (result) {
			case "completed":
				reservation.releaseAfterCompletion();
				return true;
			case "failed":
				reservation.releaseAfterFailure();
				return true;
			case "in-flight":
			case "unknown":
				return false;
			default: {
				const exhaustive: never = result;
				return exhaustive;
			}
		}
	};
	void observe(disruptiveShutdownSignal()).then(
		(resolved) => {
			if (!resolved && reservation.retained()) retryDisruptiveEvidence(observe);
		},
		() => {
			if (reservation.retained()) retryDisruptiveEvidence(observe);
		},
	);
}

export async function withServiceReservation<T>(
	fn: () => Promise<T>,
	scope: ServiceReservationScope,
	probe: ServiceCompletionProbe = probeServiceCompletion,
): Promise<T> {
	const admission =
		scope.shutdownAction === undefined
			? reserveDisruptiveAction(scope.decision(), "service", scope.owner)
			: reservePowerAction(scope.decision(), scope.shutdownAction);
	if (!admission.allowed) throw new DisruptiveActionRefusal(admission.reason);
	try {
		const result = await fn();
		admission.reservation.releaseAfterCompletion();
		return result;
	} catch (error) {
		if (isPositiveDisruptiveFailure(error) || scope.positiveFailure?.(error))
			admission.reservation.releaseAfterFailure();
		else resolveUncertainService(admission.reservation, scope, probe);
		throw error;
	}
}
