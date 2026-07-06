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
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get all modems procedure
 */
export const getAllModemsProcedure = authedProcedure
	.output(modemListSchema)
	.handler(() => {
		return modemListSchema.parse(buildModemsMessage());
	});

/**
 * Configure modem procedure
 */
export const configureModemProcedure = authedProcedure
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
export const scanModemProcedure = authedProcedure
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
export const unlockSimProcedure = authedProcedure
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
export const unlockSimPukProcedure = authedProcedure
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
