import {
	type UplinkShaperStatus,
	uplinkShaperStatusSchema,
} from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../../ui/websocket-server.ts";
import type { ShaperAlgorithm, ShaperMode } from "./contracts.ts";
import { ShaperUnavailableError } from "./contracts.ts";

export const UPLINK_SHAPER_EVENT = "uplink-shaper" as const;

let status: UplinkShaperStatus = {
	state: "available",
	mode: "idle",
	algorithm: "cake",
};
let statusKey = JSON.stringify(status);

export function getUplinkShaperStatus(): UplinkShaperStatus {
	return status;
}

export function publishShaperAvailable(
	mode: ShaperMode,
	algorithm: ShaperAlgorithm,
): void {
	publish({ state: "available", mode, algorithm });
}

export function publishShaperUnavailable(error: unknown): void {
	const reason =
		error instanceof ShaperUnavailableError ? error.reason : "tc_apply_failed";
	publish({
		state: "shaper_unavailable",
		reason,
		priorityDegraded: true,
		detail: error instanceof Error ? error.message : String(error),
	});
}

export function resetUplinkShaperStatusForTest(): void {
	status = { state: "available", mode: "idle", algorithm: "cake" };
	statusKey = JSON.stringify(status);
}

function publish(next: UplinkShaperStatus): void {
	const parsed = uplinkShaperStatusSchema.parse(next);
	const key = JSON.stringify(parsed);
	if (key === statusKey) return;
	status = parsed;
	statusKey = key;
	broadcastMsg(UPLINK_SHAPER_EVENT, status);
}
