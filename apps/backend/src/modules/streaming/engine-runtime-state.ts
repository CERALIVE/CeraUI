import { getStreamingStats, shouldUseMocks } from "../../mocks/mock-service.ts";
import type { EngineRuntimeState } from "./streaming-backend.ts";
import { getStreamingBackend } from "./streaming-engine.ts";

export async function queryEngineRuntimeStreaming(): Promise<EngineRuntimeState> {
	if (shouldUseMocks())
		return getStreamingStats().isActive ? "streaming" : "idle";
	const query = getStreamingBackend().reconcileRuntimeState;
	if (query === undefined) return "unknown";
	return query.call(getStreamingBackend());
}
