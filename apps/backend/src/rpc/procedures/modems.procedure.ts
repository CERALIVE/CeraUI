/**
 * Modems Procedures
 * Wraps existing modem logic from modules/modems/
 */

import {
	modemConfigInputSchema,
	modemListSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { buildModemsMessage } from "../../modules/modems/modem-status.ts";
import { handleModems } from "../../modules/modems/modems.ts";
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
	.handler(({ input, context }) => {
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
		return { success: true };
	});

/**
 * Scan modem networks procedure
 */
export const scanModemProcedure = authedProcedure
	.input(modemScanInputSchema)
	.output(modemScanOutputSchema)
	.handler(({ input, context }) => {
		handleModems(context.ws as unknown as import("ws").default, {
			scan: { device: input.device },
		});
		return { success: true };
	});
