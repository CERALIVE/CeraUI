import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DisruptiveActionRefusedError } from "../system/disruptive-action-error.ts";
import type { DisruptiveActionDecision } from "../system/disruptive-action-gate.ts";
import { DisruptiveActionRefusal } from "../system/disruptive-action-reservation.ts";
import type {
	ServiceCompletion,
	ServiceCompletionProbe,
} from "../system/disruptive-service-reservation.ts";

export type SysextOperation = {
	readonly id: symbol;
	readonly name: string;
};

/** A unit step names the unit whose job and lifecycle settle it. */
export type SysextStepEvidence = { readonly unit: string };

const operations = new AsyncLocalStorage<SysextOperation>();
const activeOperations = new Set<symbol>();
const SYSEXT_ACTORS = new Set(["ceralive-addon-helper", "systemd-sysext"]);
let procRoot = "/proc";
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

/**
 * Helper and refresh steps are direct sudo processes, not units, and a killed
 * helper can leave a systemd-sysext descendant running. They complete only when
 * a process table that visibly includes PID 1 holds no helper or sysext process;
 * an unreadable or filtered table proves nothing.
 */
export async function probeSysextActors(
	_scope: unknown,
	signal: AbortSignal,
): Promise<ServiceCompletion> {
	let entries: string[];
	try {
		if ((await readFile(path.join(procRoot, "1", "cmdline"))).length === 0)
			return "unknown";
		entries = await readdir(procRoot);
	} catch {
		return "unknown";
	}
	for (const entry of entries) {
		if (signal.aborted) return "unknown";
		if (!/^\d+$/.test(entry)) continue;
		let argv: string[];
		try {
			argv = (
				await readFile(path.join(procRoot, entry, "cmdline"), "utf8")
			).split("\0");
		} catch {
			continue; // exited between listing and reading
		}
		if (argv.some((arg) => SYSEXT_ACTORS.has(path.basename(arg))))
			return "in-flight";
	}
	return signal.aborted ? "unknown" : "completed";
}

export function setSysextEvidenceForTest(options?: {
	readonly procRoot?: string;
	readonly probe?: ServiceCompletionProbe;
}): void {
	procRoot = options?.procRoot ?? "/proc";
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
					unit: evidence?.unit ?? `sysext:${name}`,
					owner: operation.id,
					decision: () =>
						getDisruptiveActionDecision(
							inherited ? { heldBy: operation.id } : undefined,
						),
					positiveFailure: isRefusal,
				},
				probeOverride ??
					(evidence ? probeServiceCompletion : probeSysextActors),
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
