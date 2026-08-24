/**
 * WiFi Procedures
 * Wraps existing WiFi logic from modules/wifi/
 *
 * THE LOCK CONTRACT (and it is one lock, not two).
 *
 * Every mutating procedure here is serialized on the canonical per-adapter lock
 * keyed by `modules/wifi/wifi-adapter-lock.ts` — the module that owns the ONLY
 * key derivation in the codebase (the adapter's PERMANENT hardware address). The
 * hotspot transactions under `modules/wifi/` acquire the identical key from the
 * identical function, so an NM activation in flight really does refuse a
 * concurrent station mutation on the same radio, in both directions. A refused
 * call returns `{ success: false, error: 'DEVICE_BUSY' }` having touched no
 * state and dispatched nothing.
 *
 * WHICH LAYER TAKES THE LOCK DIFFERS BY PROCEDURE, and it has to:
 *
 *  - The STATION procedures (connect, connectNew, disconnect, forget, scan) take
 *    it here via `runGuarded`, and hold it across their DISPATCH only —
 *    `handleWifi` fires those with `void`, so they return once the work is
 *    queued. Making them awaitable under the lock is a separate change with its
 *    own RPC-latency consequences.
 *  - The HOTSPOT procedures do NOT wrap their dispatch in `runGuarded`. The
 *    transaction acquires this same key itself and holds it for the full NM
 *    activation, so wrapping it here made it refuse ITSELF: the outer lock was
 *    still held when the transaction reached `withDeviceLock`, every start/stop
 *    answered DEVICE_BUSY internally, and the procedure reported the fabricated
 *    `{ success: true }` over the top of it. `hotspotStart`/`hotspotStop` now
 *    AWAIT the transaction and return its typed outcome; `hotspotConfigure`
 *    keeps a dispatch ack and uses `adapterBusy` as an admission probe.
 *
 * ONE THING THIS CONTRACT STILL DOES NOT CLAIM: an adapter that does not RESOLVE
 * is not serialized. `runGuarded` runs `op` unguarded when the device id or
 * connection uuid names no known radio — there is no adapter to contend for, and
 * refusing would be a lie in the other direction.
 *
 * EVERY hotspot exit path ends in a terminal `wifi` frame
 * (`modules/wifi/wifi-hotspot-outcome.ts`), including the ones that resolve long
 * after the reply — so `accepted: true` is a promise of a later frame, never a
 * claim that the access point is up.
 */

import {
	type HotspotToggleOutput,
	hotspotConfigInputSchema,
	hotspotToggleInputSchema,
	hotspotToggleOutputSchema,
	type SetWifiAdapterModeOutput,
	setWifiAdapterModeInputSchema,
	setWifiAdapterModeOutputSchema,
	setWifiCountryInputSchema,
	setWifiCountryOutputSchema,
	successResponseSchema,
	type WifiAdapterModeStatus,
	wifiAdapterModeStatusSchema,
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
	buildWifiAdapterModeStatus,
	wifiAdapterModeOptions,
} from "../../modules/wifi/wifi-adapter-mode.ts";
import { publishAdapterModeOutcome } from "../../modules/wifi/wifi-adapter-mode-outcome.ts";
import { setWifiAdapterMode } from "../../modules/wifi/wifi-adapter-mode-transition.ts";
import { getWifiInterfacesByMacAddress } from "../../modules/wifi/wifi-connections.ts";
import {
	persistWifiCountry,
	setWifiCountry,
} from "../../modules/wifi/wifi-country.ts";
import { wifiHotspotStart } from "../../modules/wifi/wifi-hotspot-activation.ts";
import { wifiHotspotStop } from "../../modules/wifi/wifi-hotspot-config.ts";
import { publishHotspotOutcome } from "../../modules/wifi/wifi-hotspot-outcome.ts";
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

// Was the adapter busy at this instant? Acquires and releases immediately, so it
// never becomes the lock a later transaction has to contend with.
async function adapterBusy(
	lockKey: WifiAdapterLockKey | undefined,
): Promise<boolean> {
	if (!lockKey) return false;
	const probe = await withWifiAdapterLock(lockKey, async () => true);
	return !probe.success;
}

// A refusal decided before the transaction is reached still owes the terminal
// frame every other hotspot outcome publishes. `device` is the NUMERIC adapter
// id the transaction publishes, so every hotspot frame is keyed identically.
function refuseHotspot(
	kind: "start" | "stop",
	device: string,
): HotspotToggleOutput {
	publishHotspotOutcome(kind, Number(device), {
		success: false,
		error: "DEVICE_BUSY",
	});
	return { success: false, error: "DEVICE_BUSY" };
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
	.output(hotspotToggleOutputSchema)
	.handler(async ({ input }): Promise<HotspotToggleOutput> => {
		if (mockWifiBusy()) return refuseHotspot("start", input.device);
		/*
		  An admission PROBE, released before the transaction runs — see
		  `hotspotConfigure` below for why the lock is never held across the
		  dispatch. It answers up front for an adapter this layer can resolve; the
		  transaction's own lock is still what actually serializes the work, and
		  its DEVICE_BUSY comes back through the awaited result either way.
		*/
		if (await adapterBusy(wifiAdapterLockKeyForDeviceId(input.device))) {
			return refuseHotspot("start", input.device);
		}
		if (shouldUseMocks()) {
			if (!getMockWifiFaults().suppressConfirm) {
				const device = resolveMockWifiDevice(input.device);
				if (device) {
					getMockState().wifiModes[device] = "hotspot";
					setMockWifiConnection(device, { activeNetwork: undefined });
				}
			}
			publishHotspotOutcome("start", Number(input.device), { success: true });
			return { success: true, accepted: true };
		}

		const result = await wifiHotspotStart({ device: Number(input.device) });
		if (!result.success) return { success: false, error: result.error };
		return { success: true, accepted: true };
	});

/**
 * Stop hotspot procedure
 */
export const hotspotStopProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(hotspotToggleOutputSchema)
	.handler(async ({ input }): Promise<HotspotToggleOutput> => {
		if (mockWifiBusy()) return refuseHotspot("stop", input.device);
		// Admission probe, on `hotspotStart`'s terms.
		if (await adapterBusy(wifiAdapterLockKeyForDeviceId(input.device))) {
			return refuseHotspot("stop", input.device);
		}
		if (shouldUseMocks()) {
			if (!getMockWifiFaults().suppressConfirm) {
				const device = resolveMockWifiDevice(input.device);
				if (device) getMockState().wifiModes[device] = "station";
			}
			publishHotspotOutcome("stop", Number(input.device), { success: true });
			return { success: true };
		}

		const result = await wifiHotspotStop({ device: Number(input.device) });
		if (!result.success) return { success: false, error: result.error };
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
		/*
		  An ADMISSION PROBE, not a guard held across the work: `wifiHotspotConfig`
		  acquires this exact key itself, and holding it here while dispatching made
		  the transaction refuse ITSELF — every reconfigure answered `saving` on a
		  healthy radio. The probe still refuses a genuinely busy adapter up front;
		  the transaction's own lock remains the guarantee, and its terminal `wifi`
		  frame remains the outcome the dialog waits on.
		*/
		if (await adapterBusy(wifiAdapterLockKeyForDeviceId(input.device))) {
			return { success: false, error: "DEVICE_BUSY" };
		}

		handleWifi(ws, {
			hotspot: {
				config: {
					device: Number(input.device),
					name: input.name,
					password: input.password,
					channel: input.channel,
					...(input.security !== undefined ? { security: input.security } : {}),
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
		return { success: true };
	});

/*
  A dev host has no wiphy, so nothing can PROVE an AP+STA combination on it. The
  mock therefore offers exactly what the real derivation offers for an unprovable
  radio — `hybrid` disabled with `capability-unknown` — rather than a fabricated
  capability, which is the same rule the mock hotspot-security map already
  follows.
*/
function mockAdapterModeStatus(): WifiAdapterModeStatus {
	const state = getMockState();
	const status: WifiAdapterModeStatus = {};
	mockWifiRadios.forEach((radio, index) => {
		status[String(index)] = {
			ifname: radio.ifname,
			mode: state.wifiModes[radio.device] === "hotspot" ? "hotspot" : "station",
			options: wifiAdapterModeOptions({
				supportsHotspot: radio.supports_hotspot === true,
				staApComboSupported: undefined,
			}),
		};
	});
	return status;
}

/**
 * The observed mode, the persisted preference and the TOTAL offered set for
 * every adapter.
 *
 * It is its own pull rather than a field on `getStatus` so the offered set and
 * the refusal reasons that qualify it always travel together with the mode.
 */
export const getWifiAdapterModesProcedure = authedProcedure
	.output(wifiAdapterModeStatusSchema)
	.handler(() => {
		if (shouldUseMocks()) return mockAdapterModeStatus();
		return buildWifiAdapterModeStatus(getWifiInterfacesByMacAddress());
	});

/**
 * Switch one adapter between `station`, `hotspot` and `hybrid`.
 *
 * It takes NO `runGuarded` here, for the reason the hotspot toggles take none:
 * the transition acquires the canonical permanent-MAC key itself and holds it
 * across the NetworkManager work, and `withDeviceLock` is not re-entrant — so a
 * guard at this layer would make every mode change refuse ITSELF. The
 * transition's own admission probe answers a genuinely busy adapter.
 */
export const setWifiAdapterModeProcedure = authedProcedure
	.input(setWifiAdapterModeInputSchema)
	.output(setWifiAdapterModeOutputSchema)
	.handler(async ({ input }): Promise<SetWifiAdapterModeOutput> => {
		if (mockWifiBusy()) {
			publishAdapterModeOutcome(input.device, {
				success: false,
				error: "DEVICE_BUSY",
			});
			return { success: false, error: "DEVICE_BUSY" };
		}

		if (shouldUseMocks()) {
			const device = resolveMockWifiDevice(input.device);
			if (!device) {
				publishAdapterModeOutcome(input.device, {
					success: false,
					error: "no-device",
				});
				return { success: false, error: "no-device" };
			}
			// A dev host can express `station` and `hotspot` only: `hybrid` needs a
			// second, real netdev, and pretending otherwise would offer a mode whose
			// bond-exclusion proof has nothing to exclude.
			if (input.mode === "hybrid") {
				publishAdapterModeOutcome(input.device, {
					success: false,
					error: "capability-unproven",
				});
				return { success: false, error: "capability-unproven" };
			}
			getMockState().wifiModes[device] = input.mode;
			if (input.mode === "hotspot") {
				setMockWifiConnection(device, { activeNetwork: undefined });
			}
			publishAdapterModeOutcome(input.device, {
				success: true,
				mode: input.mode,
			});
			return { success: true, applied: input.mode };
		}

		return setWifiAdapterMode(input.device, input.mode);
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
