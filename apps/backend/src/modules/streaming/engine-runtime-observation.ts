import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineRuntimeState } from "./streaming-backend.ts";

const observations = new AsyncLocalStorage<{
	readonly current: () => boolean;
	readonly uncertainStatus: (() => void) | undefined;
}>();

export function withRuntimeObservationOwner(
	current: () => boolean,
	query: () => Promise<EngineRuntimeState>,
	uncertainStatus?: () => void,
): Promise<EngineRuntimeState> {
	return observations.run({ current, uncertainStatus }, query);
}

export function currentRuntimeObservationOwner(): () => boolean {
	return observations.getStore()?.current ?? (() => true);
}

export function currentRuntimeObservationUncertainty(): () => void {
	const observation = observations.getStore();
	return () => {
		if (observation?.current()) observation.uncertainStatus?.();
	};
}

export function classifyRuntimeState(
	state: unknown,
	streaming: unknown,
): EngineRuntimeState {
	if (state === "streaming" && streaming) return "streaming";
	if (state === "idle" && !streaming) return "idle";
	return "unknown";
}
