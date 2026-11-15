import { mockWifiRadios, shouldUseMocks } from "../mock-service.ts";

const incarnations = new Map<string, string>();

export function resolveMockWifiDevice(device: string): string | undefined {
	if (mockWifiRadios.some((radio) => radio.device === device)) return device;
	const index = Number.parseInt(device, 10);
	return Number.isNaN(index) ? undefined : mockWifiRadios[index]?.device;
}

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
