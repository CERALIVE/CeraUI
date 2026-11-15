export type StreamPillState = "live" | "idle" | "offline";

/** Offline wins, so a dropped connection never reads as live (the HUD's rule). */
export function streamPillState(
	streaming: boolean,
	offline: boolean,
): StreamPillState {
	if (offline) return "offline";
	return streaming ? "live" : "idle";
}
