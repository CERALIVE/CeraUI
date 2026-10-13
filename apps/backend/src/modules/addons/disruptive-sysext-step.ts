import { AsyncLocalStorage } from "node:async_hooks";
import { DisruptiveActionRefusedError } from "../system/disruptive-action-error.ts";
import type { DisruptiveActionDecision } from "../system/disruptive-action-gate.ts";

export type SysextOperation = {
	readonly id: symbol;
	readonly name: string;
};

const operations = new AsyncLocalStorage<SysextOperation>();
const activeOperations = new Set<symbol>();

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
	return getDisruptiveActionDecision();
}

// POWER2 replaces this snapshot with an owner-reentrant reservation. The outer
// callback lifetime includes nested helper/unit awaits; identity is not authority.
export async function runDisruptiveSysextStep<T>(
	name: string,
	effect: () => Promise<T>,
): Promise<T> {
	const { getDisruptiveActionDecision } = await import(
		"../system/disruptive-action-runtime.ts"
	);
	const inherited = currentSysextOperation();
	const operation = inherited ?? { id: Symbol(name), name };
	if (!inherited) activeOperations.add(operation.id);
	try {
		return await operations.run(operation, () => {
			const admission = getDisruptiveActionDecision();
			if (!admission.allowed)
				throw new DisruptiveActionRefusedError(admission.reason);
			return effect();
		});
	} finally {
		if (!inherited) activeOperations.delete(operation.id);
	}
}
