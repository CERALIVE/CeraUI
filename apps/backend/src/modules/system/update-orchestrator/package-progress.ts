import type { UpdateProgress } from "@ceraui/rpc/schemas";
import type { OrchestratorProgress } from "./types.ts";

export function progressFromWire(
	progress: UpdateProgress,
): OrchestratorProgress | null {
	return progress.percent === undefined
		? null
		: { percent: progress.percent, etaSeconds: 0 };
}
