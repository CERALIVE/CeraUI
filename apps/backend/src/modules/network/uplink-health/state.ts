import { UplinkHealthEngine, type UplinkHealthRecord } from "./model.ts";

let engine = new UplinkHealthEngine();
const listeners = new Set<(records: readonly UplinkHealthRecord[]) => void>();

export function getUplinkHealthEngine(): UplinkHealthEngine {
	return engine;
}

export function getUplinksMessage(): readonly UplinkHealthRecord[] {
	return engine.list();
}

export function isUplinkClientSteeringEligible(iface: string): boolean {
	return engine.isClientSteeringEligible(iface);
}

export function onUplinkHealthChange(
	listener: (records: readonly UplinkHealthRecord[]) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function notifyUplinkHealthChange(
	records: readonly UplinkHealthRecord[],
): void {
	for (const listener of [...listeners]) listener(records);
}

export function setUplinkHealthEngineForTest(
	next: UplinkHealthEngine | null,
): void {
	engine = next ?? new UplinkHealthEngine();
}
