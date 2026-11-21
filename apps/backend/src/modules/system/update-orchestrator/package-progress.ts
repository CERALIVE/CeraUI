import { packageProgressFraction } from "@ceraui/rpc/package-progress";
import type { UpdateProgress } from "@ceraui/rpc/schemas";
import type { OrchestratorProgress } from "./types.ts";

export function progressFromWire(
	progress: UpdateProgress,
): OrchestratorProgress | null {
	const fraction = packageProgressFraction(progress);
	return fraction ? { percent: fraction.percent, etaSeconds: 0 } : null;
}
