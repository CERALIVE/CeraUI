import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineRuntimeState } from "./streaming-backend.ts";

const observations = new AsyncLocalStorage<() => boolean>();

export function withRuntimeObservationOwner(
	current: () => boolean,
	query: () => Promise<EngineRuntimeState>,
): Promise<EngineRuntimeState> {
	return observations.run(current, query);
}

export function currentRuntimeObservationOwner(): () => boolean {
	return observations.getStore() ?? (() => true);
}

export function classifyRuntimeState(
	state: unknown,
	streaming: unknown,
): EngineRuntimeState {
	if (state === "streaming" && streaming) return "streaming";
	if (state === "idle" && !streaming) return "idle";
	return "unknown";
}
