import type { EngineRuntimeState } from "./streaming-backend.ts";
import { getStreamingBackend } from "./streaming-engine.ts";

export async function queryEngineRuntimeStreaming(): Promise<EngineRuntimeState> {
	const query = getStreamingBackend().reconcileRuntimeState;
	if (query === undefined) return "unknown";
	return query.call(getStreamingBackend());
}
