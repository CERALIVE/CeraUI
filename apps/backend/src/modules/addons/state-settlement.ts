import type { AddonConfig, AddonState } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { getAddons } from "../config.ts";

type StatePorts = {
	readonly setState: (id: string, state: AddonState) => void;
	readonly removeState: (id: string) => void;
	readonly broadcast: (id: string, state: AddonState) => void;
};
type StateIntent = {
	readonly id: string;
	readonly state: AddonState | undefined;
	readonly failure: string;
};
const pendingWrites = new Map<
	string,
	{ readonly state: AddonState; readonly ports: StatePorts }
>();

export function getLiveAddonState(id: string): AddonState | undefined {
	return pendingWrites.get(id)?.state ?? getAddons()[id];
}

export function getLiveAddonStates(): AddonConfig {
	const states = { ...getAddons() };
	for (const [id, pending] of pendingWrites) states[id] = pending.state;
	return states;
}

export function resetAddonSettlement(): void {
	pendingWrites.clear();
}

export function retryAddonPersistence(id: string): void {
	const pending = pendingWrites.get(id);
	if (!pending) return;
	try {
		pending.ports.setState(id, pending.state);
		pendingWrites.delete(id);
	} catch (error) {
		logger.error("addon settlement persistence retry failed", {
			id,
			err: error,
		});
	}
}

export function publishAddonSettlement(
	intent: StateIntent,
	ports: StatePorts,
): boolean {
	const { id, state, failure } = intent;
	let frame = state ?? {
		enabled: false,
		phase: "idle" as const,
		autoDisabled: false,
	};
	let persisted = false;
	try {
		if (state) ports.setState(id, state);
		else ports.removeState(id);
		pendingWrites.delete(id);
		persisted = true;
	} catch (error) {
		logger.error("addon settlement persistence failed", { id, err: error });
		frame = { ...frame, phase: "error", lastError: failure };
		pendingWrites.set(id, { state: frame, ports });
	}
	ports.broadcast(id, frame);
	return persisted;
}
