/**
 * Modems Procedures
 * Wraps existing modem logic from modules/modems/
 */

import {
	modemConfigInputSchema,
	modemListSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	simUnlockInputSchema,
	simUnlockOutputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { setMockModemConfig } from "../../mocks/mock-service.ts";
import { shouldMockModems } from "../../mocks/providers/modems.ts";
import {
	type SimUnlockResult,
	unlockSimPin,
} from "../../modules/modems/mmcli.ts";
import {
	broadcastModems,
	buildModemsMessage,
} from "../../modules/modems/modem-status.ts";
import { handleModems } from "../../modules/modems/modems.ts";
import { getModem } from "../../modules/modems/modems-state.ts";
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
		return buildModemsMessage();
	});

/**
 * Configure modem procedure
 */
export const configureModemProcedure = authedProcedure
	.input(modemConfigInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }) => {
		await withModemUpdateLock(async () => {
			handleModems(context.ws as unknown as import("ws").default, {
				config: {
					device: input.device,
					network_type: input.network_type,
					roaming: input.roaming ?? false,
					network: input.network ?? "",
					autoconfig: input.autoconfig ?? false,
					apn: input.apn,
					username: input.username,
					password: input.password,
				},
			});

			if (shouldMockModems()) {
				const roaming = input.roaming ?? false;
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
						modem.config.network = input.network ?? "";
						modem.config.autoconfig = input.autoconfig ?? false;
					}
					broadcastModems({ [modemId]: true });
				}
			}
		});

		return { success: true };
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
				scan: { device: input.device },
			});
		});
		return { success: true };
	});

/**
 * Submit a SIM PIN to unlock a PIN-locked modem.
 *
 * Runs under `withModemUpdateLock` so the unlock is serialized against the
 * modem update loop — the PIN is submitted before any (re)registration poll can
 * race it. In mock/dev mode there is no PIN-locked hardware, so we report
 * `no-locked-modem` without touching mmcli.
 */
export const unlockSimProcedure = authedProcedure
	.input(simUnlockInputSchema)
	.output(simUnlockOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			return { state: "no-locked-modem" as const };
		}

		let result: SimUnlockResult = { state: "error" };
		await withModemUpdateLock(async () => {
			result = await unlockSimPin(input.modemPath, input.pin);
		});
		return result;
	});
