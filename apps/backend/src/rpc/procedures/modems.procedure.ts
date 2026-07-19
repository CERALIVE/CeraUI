/**
 * Modems Procedures
 * Wraps existing modem logic from modules/modems/
 */

import {
	modemConfigInputSchema,
	modemConfigOutputSchema,
	modemListSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	setUsbModeInputSchema,
	setUsbModeOutputSchema,
	simPukUnlockInputSchema,
	simPukUnlockOutputSchema,
	simUnlockInputSchema,
	simUnlockOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { logger } from "../../helpers/logger.ts";
import { setMockModemConfig } from "../../mocks/mock-service.ts";
import {
	mockAttemptSimPukUnlock,
	mockAttemptSimUnlock,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";
import { assertCellularStackReady } from "../../modules/cellular/cellular-stack.ts";
import { getConfig } from "../../modules/config.ts";
import {
	type SimPukUnlockResult,
	type SimUnlockResult,
	unlockSimPin,
	unlockSimPuk,
} from "../../modules/modems/mmcli.ts";
import {
	broadcastModems,
	buildModemsMessage,
} from "../../modules/modems/modem-status.ts";
import { handleModems } from "../../modules/modems/modems.ts";
import { getModem } from "../../modules/modems/modems-state.ts";
import { clearSimPin, storeSimPin } from "../../modules/modems/sim-secrets.ts";
import { withModemUpdateLock } from "../../modules/network/state/device-lock.ts";
import { withLifecycleLock } from "../../modules/streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { isRealDevice } from "../../modules/system/device-detection.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

// Gate every modem procedure on the cellular-stack composition root: while a
// dbus backend is still initializing, `assertCellularStackReady` throws the
// shared typed `CELLULAR_STACK_INITIALIZING` oRPC error. A no-op on the ready
// mmcli default, so the default path is unaffected.
const cellularStackMiddleware = baseProcedure.middleware(async ({ next }) => {
	assertCellularStackReady();
	return next();
});

const modemProcedure = authedProcedure.use(cellularStackMiddleware);

/**
 * Get all modems procedure
 */
export const getAllModemsProcedure = modemProcedure
	.output(modemListSchema)
	.handler(() => {
		return modemListSchema.parse(buildModemsMessage());
	});

/**
 * Configure modem procedure
 */
export const configureModemProcedure = modemProcedure
	.input(modemConfigInputSchema)
	.output(modemConfigOutputSchema)
	.handler(async ({ input, context }) => {
		// Normalised (post-clamp) config the device actually persists.
		const roaming = input.roaming ?? false;
		const network = input.network ?? "";
		const autoconfig = input.autoconfig ?? false;

		await withModemUpdateLock(async () => {
			handleModems(context.ws as unknown as import("ws").default, {
				config: {
					device: Number(input.device),
					network_type: input.network_type,
					roaming,
					network,
					autoconfig,
					apn: input.apn,
					username: input.username,
					password: input.password,
				},
			});

			if (shouldMockModems()) {
				setMockModemConfig(input.device, {
					apn: input.apn,
					network_type_active: input.network_type,
					roaming,
				});

				const modemId = Number(input.device);
				const modem = getModem(modemId);
				if (modem) {
					modem.network_type.active = input.network_type;
					if (modem.config) {
						modem.config.apn = input.apn;
						modem.config.username = input.username;
						modem.config.password = input.password;
						modem.config.roaming = roaming;
						modem.config.network = network;
						modem.config.autoconfig = autoconfig;
					}
					broadcastModems({ [modemId]: true });
				}
			}
		});

		return {
			success: true,
			applied: {
				device: input.device,
				network_type: input.network_type,
				roaming,
				network,
				autoconfig,
				apn: input.apn,
				username: input.username,
				password: input.password,
			},
		};
	});

/**
 * Scan modem networks procedure
 */
export const scanModemProcedure = modemProcedure
	.input(modemScanInputSchema)
	.output(modemScanOutputSchema)
	.handler(async ({ input, context }) => {
		await withModemUpdateLock(async () => {
			handleModems(context.ws as unknown as import("ws").default, {
				scan: { device: String(input.device) },
			});
		});
		return { success: true };
	});

/**
 * Submit a SIM PIN to unlock a PIN-locked modem.
 *
 * Runs under `withModemUpdateLock` so the unlock is serialized against the
 * modem update loop — the PIN is submitted before any (re)registration poll can
 * race it. In mock/dev mode there is no PIN-locked hardware, so we route the
 * submit through the deterministic mock SIM state machine
 * ({@link mockAttemptSimUnlock}) — the `modem-pin-locked` scenario seeds a
 * PIN-locked modem (fixture PIN "0000") so the full unlock/PUK flow works
 * end-to-end in dev. The `remember`/`storeSimPin`/`clearSimPin` persistence
 * branch is real-device only — it never runs under mocks (no `/run/ceralive`
 * writes on a dev host).
 */
export const unlockSimProcedure = modemProcedure
	.input(simUnlockInputSchema)
	.output(simUnlockOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			return mockAttemptSimUnlock(input.modemPath, input.pin);
		}

		let result: SimUnlockResult = { state: "error" };
		await withModemUpdateLock(async () => {
			result = await unlockSimPin(input.modemPath, input.pin);
		});

		// Opt-in "remember PIN": persist ONLY a confirmed-correct PIN to the
		// chmod-600 tmpfs secrets file (never config.json) so boot auto-unlock has
		// it. `remember: false` opts back out and clears any stored PIN; an absent
		// flag leaves the stored PIN untouched. Persistence never fails the unlock.
		if (
			(result as SimUnlockResult).state === "success" &&
			input.remember !== undefined
		) {
			try {
				if (input.remember) {
					await storeSimPin(input.pin);
				} else {
					await clearSimPin();
				}
			} catch (err) {
				logger.warn(`SIM PIN remember toggle failed: ${err}`);
			}
		}

		return result;
	});

/**
 * Submit a SIM PUK + new PIN to recover a PUK-locked modem.
 *
 * The companion to {@link unlockSimProcedure} for the case where wrong-PIN
 * attempts are exhausted and only the carrier PUK can restore the SIM. Runs
 * under `withModemUpdateLock` so the submit is serialized against the modem
 * update loop. In mock/dev mode there is no PUK-locked hardware, so we route the
 * submit through the deterministic mock SIM state machine
 * ({@link mockAttemptSimPukUnlock}) — exhausting the PIN attempts in the
 * `modem-pin-locked` scenario trips the SIM to PUK-locked, and the fixture PUK
 * "12345678" recovers it, so the full PUK flow works end-to-end in dev.
 */
export const unlockSimPukProcedure = modemProcedure
	.input(simPukUnlockInputSchema)
	.output(simPukUnlockOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			return mockAttemptSimPukUnlock(input.modemPath, input.puk);
		}

		let result: SimPukUnlockResult = { success: false, error: "error" };
		await withModemUpdateLock(async () => {
			result = await unlockSimPuk(input.modemPath, input.puk, input.newPin);
		});
		return result;
	});

/**
 * Switch a modem's USB composition mode (Phase B, T5.4).
 *
 * DEFAULT-ABSENT GATE: the guarded mutation is UNREACHABLE unless the operator has
 * provisioned it. The FIRST guard reads the `modem_provisioning` config key and
 * refuses with the typed `provisioning_disabled` error whenever it is absent/false
 * — a hard RPC-layer refusal, not a hidden UI control, so a direct RPC call is
 * refused too. The full re-enumeration transaction (cached-UID inhibit, port-drop,
 * re-enumeration wait, postcondition verify) is a later wave; the streaming
 * LifecycleInterlock is Todo 27. This wave ships only the gate + the emulated-mode
 * refusal, so any code path past the gate stays a typed refusal for now.
 */
export const setUsbModeProcedure = modemProcedure
	.input(setUsbModeInputSchema)
	.output(setUsbModeOutputSchema)
	.handler(async () => {
		if (getConfig().modem_provisioning !== true) {
			return { success: false, error: "provisioning_disabled" };
		}

		if (!(await isRealDevice())) {
			return { success: false, error: "unavailable_in_emulated_mode" };
		}

		// LifecycleInterlock (Phase B, T5.5): a USB-composition switch re-enumerates
		// the modem, tearing its bond link down mid-transition. Refuse while a stream
		// is LIVE or being ADMITTED. getIsStreaming() covers the live window; the
		// interlock closes the admission-window race a bare is_streaming check would
		// miss (admitted-start, not just is_streaming). Holding the interlock across
		// the transition blocks a concurrent stream admission in turn (both race
		// orders); withLifecycleLock releases it in a finally on ANY exit.
		if (getIsStreaming()) {
			return { success: false, error: "streaming_active" };
		}
		const outcome = await withLifecycleLock("modem-transition", async () => {
			// The full re-enumeration transaction (cached-UID inhibit, port-drop,
			// re-enumeration wait, postcondition verify) is a later wave; autonomous
			// cellular recovery stays default-disabled. This wave ships the interlock
			// + gate, so any path past the gate stays a typed refusal for now.
			logger.warn(
				"modems.setUsbMode reached past the provisioning + streaming gates but the transition transaction is not yet implemented (Phase-B later wave)",
			);
			return { success: false, error: "error" } as const;
		});
		if (!outcome.acquired) {
			return { success: false, error: "streaming_active" };
		}
		return outcome.result;
	});
