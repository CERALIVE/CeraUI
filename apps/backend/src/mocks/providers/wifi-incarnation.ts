import { mockWifiRadios, shouldUseMocks } from "../mock-service.ts";

const incarnations = new Map<string, string>();

export function getMockWifiIncarnation(device: string): string {
	const token = incarnations.get(device) ?? crypto.randomUUID();
	incarnations.set(device, token);
	return token;
}

/** Protocol-only replug simulation; credentials, modes and connections stay put. */
export function rebindMockWifi(device: string): boolean {
	if (
		!shouldUseMocks() ||
		!mockWifiRadios.some((radio) => radio.device === device)
	) {
		return false;
	}
	incarnations.set(device, crypto.randomUUID());
	return true;
}

export function resetMockWifiIncarnations(): void {
	incarnations.clear();
}
