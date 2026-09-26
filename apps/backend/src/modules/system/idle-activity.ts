import type { UpdateSettings } from "@ceraui/rpc/schemas";
import {
	getLastRemoteCommandAt,
	hasActiveRemoteSession,
} from "../remote-control/command-router.ts";
import { currentLifecycleHolder } from "../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { getActivePreviewProxyCount } from "../ui/preview-proxy.ts";
import { evaluateIdle, type IdleEvaluation } from "./idle-detector.ts";
import { getIdleMemory, loadIdleState } from "./idle-state.ts";

export { noteUiHeartbeat, setIdleStateFilePathForTest } from "./idle-state.ts";

export async function getIdleStatus(input: {
	readonly now: number;
	readonly schedule: UpdateSettings["schedule"];
}): Promise<IdleEvaluation> {
	const lastStreamEndedAt = await loadIdleState();
	const memory = getIdleMemory();
	return evaluateIdle({
		now: input.now,
		idleMinutes: 30,
		schedule: input.schedule,
		lastActivity: {
			stream: getIsStreaming()
				? input.now
				: Math.max(lastStreamEndedAt ?? 0, memory.bootAt),
			preview: getActivePreviewProxyCount() > 0 ? input.now : memory.preview,
			remote: hasActiveRemoteSession(input.now)
				? input.now
				: getLastRemoteCommandAt(),
			ui: memory.ui,
			startLease:
				currentLifecycleHolder() === "streaming"
					? input.now
					: memory.startLease,
		},
	});
}
