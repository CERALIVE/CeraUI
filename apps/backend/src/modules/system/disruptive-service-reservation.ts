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
	readonly settlement?: "evidence-required";
};
export type ServiceCompletionProbe = (
	scope: ServiceReservationScope,
	signal: AbortSignal,
) => Promise<ServiceCompletion>;

// The steady active sub-state of each unit type an add-on descriptor may name
// (the descriptor schema admits exactly these six suffixes). A listening socket
// or a waiting timer is settled, never "in flight forever"; an unrecognised
// type settles only through inactive/dead or failed/failed.
const SETTLED_ACTIVE_SUBSTATES: Readonly<Record<string, ReadonlySet<string>>> =
	{
		service: new Set(["running", "exited"]),
		socket: new Set(["listening"]),
		timer: new Set(["waiting", "elapsed"]),
		path: new Set(["waiting"]),
		target: new Set(["active"]),
		mount: new Set(["mounted"]),
	};
const NO_SUBSTATES: ReadonlySet<string> = new Set();

function settledActiveSubStates(unit: string): ReadonlySet<string> {
	// systemctl reads a suffix-less name as a .service unit.
	const dot = unit.lastIndexOf(".");
	const suffix = dot < 0 ? "service" : unit.slice(dot + 1);
	return Object.hasOwn(SETTLED_ACTIVE_SUBSTATES, suffix)
		? (SETTLED_ACTIVE_SUBSTATES[suffix] ?? NO_SUBSTATES)
		: NO_SUBSTATES;
}

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
		(active === "active" &&
			settledActiveSubStates(scope.unit).has(sub ?? "")) ||
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

async function resolveUncertainService(
	reservation: DisruptiveReservation,
	scope: ServiceReservationScope,
	probe: ServiceCompletionProbe,
): Promise<void> {
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
	const signal = disruptiveShutdownSignal();
	try {
		if (!(await observe(signal)) && reservation.retained() && !signal.aborted)
			retryDisruptiveEvidence(observe);
	} catch {
		if (reservation.retained() && !signal.aborted)
			retryDisruptiveEvidence(observe);
	}
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
		if (scope.settlement === "evidence-required")
			await resolveUncertainService(admission.reservation, scope, probe);
		else admission.reservation.releaseAfterCompletion();
		return result;
	} catch (error) {
		if (
			scope.positiveFailure?.(error) ||
			(scope.settlement !== "evidence-required" &&
				isPositiveDisruptiveFailure(error))
		)
			admission.reservation.releaseAfterFailure();
		else if (scope.settlement === "evidence-required")
			await resolveUncertainService(admission.reservation, scope, probe);
		else void resolveUncertainService(admission.reservation, scope, probe);
		throw error;
	}
}
