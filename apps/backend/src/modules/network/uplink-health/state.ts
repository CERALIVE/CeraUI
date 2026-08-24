import { UplinkHealthEngine, type UplinkHealthRecord } from "./model.ts";

let engine = new UplinkHealthEngine();

export function getUplinkHealthEngine(): UplinkHealthEngine {
	return engine;
}

export function getUplinksMessage(): readonly UplinkHealthRecord[] {
	return engine.list();
}

export function isUplinkClientSteeringEligible(iface: string): boolean {
	return engine.isClientSteeringEligible(iface);
}

export function setUplinkHealthEngineForTest(
	next: UplinkHealthEngine | null,
): void {
	engine = next ?? new UplinkHealthEngine();
}
