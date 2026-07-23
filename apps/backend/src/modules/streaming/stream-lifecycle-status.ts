import type { LifecycleState } from "@ceraui/rpc/schemas";
import { broadcastMsg } from "../ui/websocket-server.ts";

let lifecycleState: LifecycleState = "idle";

export function getStreamLifecycleState(): LifecycleState {
	return lifecycleState;
}

export function updateStreamLifecycleState(state: LifecycleState): void {
	lifecycleState = state;
	broadcastMsg("status", { stream_lifecycle: state });
}
