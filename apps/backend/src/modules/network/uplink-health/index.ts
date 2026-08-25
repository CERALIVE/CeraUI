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
	type ProbeTargetClass,
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
