import { AsyncLocalStorage } from "node:async_hooks";
import { DisruptiveActionRefusedError } from "../system/disruptive-action-error.ts";
import type { DisruptiveActionDecision } from "../system/disruptive-action-gate.ts";

export type SysextOperation = {
	readonly id: symbol;
	readonly name: string;
};

const operations = new AsyncLocalStorage<SysextOperation>();

export function currentSysextOperation(): SysextOperation | undefined {
	return operations.getStore();
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
	const operation = operations.getStore() ?? { id: Symbol(name), name };
	const { getDisruptiveActionDecision } = await import(
		"../system/disruptive-action-runtime.ts"
	);
	return operations.run(operation, () => {
		const admission = getDisruptiveActionDecision();
		if (!admission.allowed)
			throw new DisruptiveActionRefusedError(admission.reason);
		return effect();
	});
}
