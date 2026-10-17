import { AsyncLocalStorage } from "node:async_hooks";
import type { AddonHelperStep } from "../../helpers/addon-helper-step.ts";
import { DisruptiveActionRefusedError } from "../system/disruptive-action-error.ts";
import type { DisruptiveActionDecision } from "../system/disruptive-action-gate.ts";
import { DisruptiveActionRefusal } from "../system/disruptive-action-reservation.ts";
import type { ServiceCompletionProbe } from "../system/disruptive-service-reservation.ts";
import {
	type ProcIo,
	probeSysextActors,
	setSysextCensusForTest,
} from "./sysext-process-census.ts";

export {
	executableIdentity,
	probeSysextActors,
} from "./sysext-process-census.ts";

export type SysextOperation = {
	readonly id: symbol;
	readonly name: string;
};

/** A unit step names the unit whose job and lifecycle settle it. */
export type SysextStepEvidence =
	| { readonly unit: string }
	| { readonly units: readonly string[]; readonly helper?: AddonHelperStep };

const operations = new AsyncLocalStorage<SysextOperation>();
const activeOperations = new Set<symbol>();
let probeOverride: ServiceCompletionProbe | undefined;

export function currentSysextOperation(): SysextOperation | undefined {
	const operation = operations.getStore();
	return operation && activeOperations.has(operation.id)
		? operation
		: undefined;
}

export function outsideSysextOperation<T>(callback: () => T): T {
	return operations.exit(callback);
}

export async function getSysextActionDecision(): Promise<DisruptiveActionDecision> {
	const { getDisruptiveActionDecision } = await import(
		"../system/disruptive-action-runtime.ts"
	);
	const current = currentSysextOperation();
	return getDisruptiveActionDecision(
		current ? { heldBy: current.id } : undefined,
	);
}

export function setSysextEvidenceForTest(options?: {
	readonly procRoot?: string;
	readonly procIo?: ProcIo;
	readonly probe?: ServiceCompletionProbe;
}): void {
	setSysextCensusForTest(options);
	probeOverride = options?.probe;
}

const isRefusal = (error: unknown): boolean =>
	error instanceof DisruptiveActionRefusedError ||
	error instanceof DisruptiveActionRefusal;

// The still-active operation owns one service-lifetime reservation. Nested
// steps re-enter it by depth; only the outermost release reopens admission.
// A descendant of a released operation never mints a fresh owner.
export async function runDisruptiveSysextStep<T>(
	name: string,
	effect: () => Promise<T>,
	evidence?: SysextStepEvidence,
): Promise<T> {
	const [
		{ getDisruptiveActionDecision },
		{ probeServiceCompletion, withServiceReservation },
	] = await Promise.all([
		import("../system/disruptive-action-runtime.ts"),
		import("../system/disruptive-service-reservation.ts"),
	]);
	const inherited = currentSysextOperation();
	if (!inherited && operations.getStore() !== undefined)
		throw new DisruptiveActionRefusedError("update_in_progress");
	const operation = inherited ?? { id: Symbol(name), name };
	const helper = evidence && "helper" in evidence ? evidence.helper : undefined;
	if (!inherited) activeOperations.add(operation.id);
	let entered = false;
	try {
		return await operations.run(operation, () =>
			withServiceReservation(
				() => {
					entered = true;
					return effect();
				},
				{
					unit:
						evidence && "unit" in evidence ? evidence.unit : `sysext:${name}`,
					owner: operation.id,
					decision: () =>
						getDisruptiveActionDecision(
							inherited ? { heldBy: operation.id } : undefined,
						),
					...(helper ? { settlement: "evidence-required" as const } : {}),
					positiveFailure: helper
						? () => helper.dispatch() === "none"
						: isRefusal,
				},
				(helper ? undefined : probeOverride) ??
					(evidence && "unit" in evidence
						? probeServiceCompletion
						: async (scope, signal) => {
								const actors = helper
									? await helper.probe(signal)
									: await probeSysextActors(scope, signal);
								if (actors !== "completed") return actors;
								for (const unit of evidence?.units ?? []) {
									if (signal.aborted) return "unknown";
									const result = await (
										probeOverride ?? probeServiceCompletion
									)({ ...scope, unit }, signal);
									if (result !== "completed") return result;
								}
								return "completed";
							}),
			),
		);
	} catch (error) {
		if (!entered && error instanceof DisruptiveActionRefusal)
			throw new DisruptiveActionRefusedError(error.reason);
		throw error;
	} finally {
		if (!inherited) activeOperations.delete(operation.id);
	}
}
