/**
 * WiFi Procedures
 * Wraps existing WiFi logic from modules/wifi/
 *
 * THE LOCK CONTRACT (and it is one lock, not two).
 *
 * Every mutating procedure here — connect, connectNew, disconnect, forget,
 * scan, hotspotStart, hotspotStop, hotspotConfigure — acquires the canonical
 * per-adapter lock through `runGuarded`, keyed by
 * `modules/wifi/wifi-adapter-lock.ts`. That module owns the ONLY key
 * derivation in the codebase (the adapter's PERMANENT hardware address), and
 * the hotspot start/stop/reconfigure transactions under `modules/wifi/` acquire
 * the identical key from the identical function — so an NM activation in flight
 * really does refuse a concurrent station mutation on the same radio, in both
 * directions. A refused call returns `{ success: false, error: 'DEVICE_BUSY' }`
 * having touched no state and dispatched nothing.
 *
 * TWO THINGS THIS CONTRACT DOES NOT CLAIM, because both were claimed falsely
 * before and are worth stating plainly:
 *
 *  - An adapter that does not RESOLVE is not serialized. `runGuarded` runs `op`
 *    unguarded when the device id / connection uuid names no known radio: there
 *    is no adapter to contend for, and refusing would be a lie in the other
 *    direction.
 *  - The station procedures hold the lock across their DISPATCH, not across the
 *    nmcli work. `handleWifi` fires connect/disconnect/forget/scan/new with
 *    `void`, so those calls return once the work is queued. The hotspot
 *    transactions DO hold the lock for their full NM activation, which is the
 *    ordering that matters — the destructive, multi-step operation cannot be
 *    interleaved with a station mutation. Making the station legs awaitable
 *    under the lock is a separate change with its own RPC-latency consequences.
 */

import {
	hotspotConfigInputSchema,
	hotspotToggleInputSchema,
	setWifiCountryInputSchema,
	setWifiCountryOutputSchema,
	successResponseSchema,
	wifiConnectInputSchema,
	wifiDisconnectInputSchema,
	wifiForgetInputSchema,
	wifiNewInputSchema,
	wifiOperationOutputSchema,
	wifiScanInputSchema,
	wifiStatusSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import {
	getMockState,
	mockWifiRadios,
	mockWifiSsidForUuid,
	setMockWifiConnection,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import {
	getMockWifiFaults,
	setMockHotspotConfig,
} from "../../mocks/providers/wifi.ts";
import { isRealDevice } from "../../modules/system/device-detection.ts";
import { handleWifi, wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import {
	type WifiAdapterLockKey,
	wifiAdapterLockKeyForConnectionUuid,
	wifiAdapterLockKeyForDeviceId,
	withWifiAdapterLock,
} from "../../modules/wifi/wifi-adapter-lock.ts";
import {
	persistWifiCountry,
	setWifiCountry,
} from "../../modules/wifi/wifi-country.ts";
import { broadcast } from "../events.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const MOCK_WIFI_DEVICE = "wlan0";

// The WifiStatus key (radio index) the frontend op store keys `wifi:<id>` on for
// the mock wlan0 — used as the `device` field of the injected fault frames so a
// forced failure resolves the SAME keyed operation the dialog dispatched.
const MOCK_WIFI_DEVICE_INDEX = String(
	Math.max(
		0,
		mockWifiRadios.findIndex((radio) => radio.device === MOCK_WIFI_DEVICE),
	),
);

type MutationResult = {
	success: boolean;
	error?: "auth" | "generic" | "DEVICE_BUSY";
};

// Mock-seam DEVICE_BUSY knob: in mock mode a forced-busy fault makes every
// mutating WiFi op return the same contention signal the device-lock would, so
// the dialog's calm busy toast + re-enable path is exercisable without a real
// concurrent operation.
function mockWifiBusy(): boolean {
	return shouldUseMocks() && getMockWifiFaults().deviceBusy;
}

function resolveMockWifiDevice(device: string): string | undefined {
	if (mockWifiRadios.some((radio) => radio.device === device)) return device;
	const index = Number.parseInt(device, 10);
	return Number.isNaN(index) ? undefined : mockWifiRadios[index]?.device;
}

// Run `op` under the canonical per-adapter lock when the adapter resolves;
// returns true when the lock rejected the call (busy). When the adapter cannot
// be resolved there is no radio to serialize against, so `op` runs unguarded.
async function runGuarded(
	lockKey: WifiAdapterLockKey | undefined,
	op: () => void | Promise<void>,
): Promise<boolean> {
	if (!lockKey) {
		await op();
		return false;
	}
	const result = await withWifiAdapterLock(lockKey, async () => {
		await op();
	});
	return !result.success;
}

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get WiFi status procedure
 */
export const getWifiStatusProcedure = authedProcedure
	.output(wifiStatusSchema)
	.handler(() => {
		return wifiStatusSchema.parse(wifiBuildMsg());
	});

/**
 * Connect to saved WiFi procedure
 */
export const wifiConnectProcedure = authedProcedure
	.input(wifiConnectInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForConnectionUuid(input.uuid);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, { connect: input.uuid });
			if (shouldUseMocks()) {
				const faults = getMockWifiFaults();
				if (faults.savedConnectFails) {
					// Emit the failing result frame the WifiSelectorDialog routes into
					// the keyed op store → failed (calm re-enable, no snapshot mutation).
					broadcast("wifi", {
						connect: false,
						device: MOCK_WIFI_DEVICE_INDEX,
					});
				} else if (!faults.suppressConfirm) {
					const ssid = mockWifiSsidForUuid(input.uuid);
					if (ssid) {
						setMockWifiConnection(MOCK_WIFI_DEVICE, { activeNetwork: ssid });
					}
				}
				// suppressConfirm: accept but never mark active → op stays pending →
				// the frontend TTL valve flips it to timed_out.
			}
			broadcast("wifi", { connect: [input.uuid] });
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Disconnect WiFi procedure
 */
export const wifiDisconnectProcedure = authedProcedure
	.input(wifiDisconnectInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForConnectionUuid(input.uuid);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, { disconnect: input.uuid });
			if (shouldUseMocks() && !getMockWifiFaults().suppressConfirm) {
				setMockWifiConnection(MOCK_WIFI_DEVICE, { activeNetwork: undefined });
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Connect to new WiFi procedure
 */
export const wifiConnectNewProcedure = authedProcedure
	.input(wifiNewInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForDeviceId(input.device);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, {
				new: {
					device: Number(input.device),
					ssid: input.ssid,
					password: input.password,
					...(input.security !== undefined ? { security: input.security } : {}),
				},
			});
			if (shouldUseMocks()) {
				const faults = getMockWifiFaults();
				if (faults.connectNewAuthFails) {
					// Wrong-password result: route into the keyed op store as a failure on
					// the SAME device key the dialog dispatched (calm re-enable).
					broadcast("wifi", {
						new: { error: "auth", device: input.device },
					});
				} else if (!faults.suppressConfirm) {
					const current = getMockState().wifiConnections.get(MOCK_WIFI_DEVICE);
					const savedNetworks = current?.savedNetworks ?? [];
					setMockWifiConnection(MOCK_WIFI_DEVICE, {
						activeNetwork: input.ssid,
						savedNetworks: savedNetworks.includes(input.ssid)
							? savedNetworks
							: [...savedNetworks, input.ssid],
					});
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Forget WiFi procedure
 */
export const wifiForgetProcedure = authedProcedure
	.input(wifiForgetInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForConnectionUuid(input.uuid);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, { forget: input.uuid });
			if (shouldUseMocks()) {
				const ssid = mockWifiSsidForUuid(input.uuid);
				if (ssid) {
					const current = getMockState().wifiConnections.get(MOCK_WIFI_DEVICE);
					setMockWifiConnection(MOCK_WIFI_DEVICE, {
						savedNetworks: (current?.savedNetworks ?? []).filter(
							(s) => s !== ssid,
						),
						activeNetwork:
							current?.activeNetwork === ssid
								? undefined
								: current?.activeNetwork,
					});
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Scan WiFi procedure
 */
export const wifiScanProcedure = authedProcedure
	.input(wifiScanInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForDeviceId(input.device);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, { scan: Number(input.device) });
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Start hotspot procedure
 */
export const hotspotStartProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForDeviceId(input.device);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, {
				hotspot: { start: { device: Number(input.device) } },
			});
			if (shouldUseMocks() && !getMockWifiFaults().suppressConfirm) {
				const device = resolveMockWifiDevice(input.device);
				if (device) {
					getMockState().wifiModes[device] = "hotspot";
					setMockWifiConnection(device, { activeNetwork: undefined });
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Stop hotspot procedure
 */
export const hotspotStopProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForDeviceId(input.device);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, {
				hotspot: { stop: { device: Number(input.device) } },
			});
			if (shouldUseMocks() && !getMockWifiFaults().suppressConfirm) {
				const device = resolveMockWifiDevice(input.device);
				if (device) {
					getMockState().wifiModes[device] = "station";
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Configure hotspot procedure
 */
export const hotspotConfigureProcedure = authedProcedure
	.input(hotspotConfigInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		if (mockWifiBusy()) return { success: false, error: "DEVICE_BUSY" };
		const ws = context.ws;
		const lockKey = wifiAdapterLockKeyForDeviceId(input.device);
		const busy = await runGuarded(lockKey, () => {
			handleWifi(ws, {
				hotspot: {
					config: {
						device: Number(input.device),
						name: input.name,
						password: input.password,
						channel: input.channel,
						...(input.security !== undefined
							? { security: input.security }
							: {}),
					},
				},
			});
			if (shouldUseMocks()) {
				const device = resolveMockWifiDevice(input.device);
				if (device) {
					setMockHotspotConfig(device, {
						name: input.name,
						password: input.password,
						channel: input.channel,
					});
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Set the device regulatory country. Mirrors `network.setIngestEnabled`: the
 * mock branch persists so dev/e2e exercise the real selection path, but NEVER
 * reaches `iw reg set` — a dev host's own regulatory domain is not ours to move.
 */
export const setWifiCountryProcedure = authedProcedure
	.input(setWifiCountryInputSchema)
	.output(setWifiCountryOutputSchema)
	.handler(async ({ input }) => {
		if (shouldUseMocks()) return persistWifiCountry(input.country);

		if (!(await isRealDevice())) {
			return {
				success: false,
				error: "unavailable_in_emulated_mode" as const,
			};
		}

		return setWifiCountry(input.country);
	});
