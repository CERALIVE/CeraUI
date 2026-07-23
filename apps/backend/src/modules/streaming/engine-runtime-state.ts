import { getStreamingBackend } from "./streaming-engine.ts";

export class EngineRuntimeStateTimeoutError extends Error {
	override readonly name = "EngineRuntimeStateTimeoutError";
}

export async function queryEngineRuntimeStreaming(): Promise<boolean> {
	const query = getStreamingBackend().reconcileRuntimeState;
	if (query === undefined) throw new EngineRuntimeStateTimeoutError();
	return query.call(getStreamingBackend());
}
