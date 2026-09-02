export {
	CONNECTIVITY_TARGET_TTL_MS,
	type ConnectivityTargetDeps,
	type ConnectivityTargetResolver,
	createConnectivityTargetResolver,
} from "./connectivity-target.ts";
export {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	type UplinkHealthReason,
	type UplinkHealthRecord,
	type UplinkHealthState,
	type UplinkKind,
} from "./model.ts";
export {
	initUplinkHealth,
	setUplinkHealthRuntimeForTest,
	UPLINKS_EVENT,
	UplinkHealthRuntime,
} from "./runtime.ts";
export {
	getUplinkHealthEngine,
	getUplinksMessage,
	isUplinkClientSteeringEligible,
	onUplinkHealthChange,
	setUplinkHealthEngineForTest,
} from "./state.ts";
