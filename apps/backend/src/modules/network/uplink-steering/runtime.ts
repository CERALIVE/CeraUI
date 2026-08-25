import { uplinkFlowsResetEventSchema } from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
import { isRealDevice } from "../../system/device-detection.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { onNetworkInterfacesChange } from "../network-interfaces.ts";
import { onUplinkHealthChange } from "../uplink-health/state.ts";
import {
	applyNftablesRules,
	deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
} from "../uplink-sharing.ts";
import { UplinkSteeringApplier } from "./applier.ts";
import { UplinkSteeringCoordinator } from "./coordinator.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
} from "./route-manager.ts";
import { readDesiredSteeringState } from "./state-builder.ts";
import {
	publishUplinkSteeringAvailability,
	UPLINK_FLOWS_RESET_EVENT,
} from "./status.ts";

const applier = new UplinkSteeringApplier({
	discoverRoutes: discoverOwnedUplinkRoutes,
	ensureRoute: ensureUplinkRoute,
	rollbackRoute: rollbackUplinkRoute,
	removeRoute: removeUplinkRoute,
	applyRuleset: (ruleset, mode) => applyNftablesRules(ruleset, undefined, mode),
	deactivateSharing: deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
	publishFlowsReset: (event) =>
		broadcastMsg(
			UPLINK_FLOWS_RESET_EVENT,
			uplinkFlowsResetEventSchema.parse(event),
		),
});

const coordinator = new UplinkSteeringCoordinator({
	readDesiredState: readDesiredSteeringState,
	apply: (previous, next) => applier.apply(previous, next),
	publishAvailability: publishUplinkSteeringAvailability,
});

let unsubscribeNetif: (() => void) | undefined;
let unsubscribeHealth: (() => void) | undefined;

export async function initUplinkSteering(): Promise<void> {
	if (unsubscribeNetif !== undefined || !(await isRealDevice())) return;
	const reconcile = () => {
		void coordinator.requestReconcile().catch((error: unknown) => {
			logger.warn("uplink steering reconcile failed", { err: error });
		});
	};
	unsubscribeNetif = onNetworkInterfacesChange(reconcile);
	unsubscribeHealth = onUplinkHealthChange(reconcile);
	await coordinator.requestReconcile();
}

export function requestUplinkSteeringReconcile(): Promise<void> {
	return coordinator.requestReconcile();
}

export function stopUplinkSteeringForTest(): void {
	unsubscribeNetif?.();
	unsubscribeHealth?.();
	unsubscribeNetif = undefined;
	unsubscribeHealth = undefined;
}
