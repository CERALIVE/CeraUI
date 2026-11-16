import { CLIENT_FLOW_NAMESPACE } from "./contracts.ts";

export const MANAGED_TABLE_BASE = 30_000;

export function markForSlot(slot: number): number {
	return (CLIENT_FLOW_NAMESPACE | ((slot || 1) << 8)) >>> 0;
}

export function isManagedUplinkTable(table: string): boolean {
	if (!/^\d+$/.test(table)) return false;
	const value = Number.parseInt(table, 10);
	return value >= MANAGED_TABLE_BASE && value <= MANAGED_TABLE_BASE + 0xffff;
}

export function slotForManagedTable(table: string): number | undefined {
	const slot = Number(table) - MANAGED_TABLE_BASE;
	return isManagedUplinkTable(table) && slot > 0 ? slot : undefined;
}
