import { uplinkSteeringStatusSchema } from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../../ui/websocket-server.ts";
import type {
	SteeringAvailability,
	UplinkSteeringStatus,
} from "./contracts.ts";

export const UPLINK_STEERING_EVENT = "uplink-steering" as const;
export const UPLINK_FLOWS_RESET_EVENT = "uplink-flows-reset" as const;

let status: UplinkSteeringStatus = { state: "available" };
let statusKey = JSON.stringify(status);

export function getUplinkSteeringStatus(): UplinkSteeringStatus {
	return status;
}

export function publishUplinkSteeringAvailability(
	availability: SteeringAvailability,
): void {
	const next: UplinkSteeringStatus = availability.available
		? { state: "available" }
		: {
				state: "steering_unavailable",
				reason: availability.reason,
				...(availability.detail === undefined
					? {}
					: { detail: availability.detail }),
			};
	const nextKey = JSON.stringify(next);
	if (nextKey === statusKey) return;
	status = uplinkSteeringStatusSchema.parse(next);
	statusKey = JSON.stringify(status);
	broadcastMsg(UPLINK_STEERING_EVENT, status);
}

export function resetUplinkSteeringStatusForTest(): void {
	status = { state: "available" };
	statusKey = JSON.stringify(status);
}
