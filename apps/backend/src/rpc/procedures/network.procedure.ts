/**
 * Network Interface Procedures
 * Wraps existing network logic from modules/network/
 */

import {
	netifConfigInputSchema,
	netifConfigOutputSchema,
	netifMessageSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import {
	handleNetif,
	netIfBuildMsg,
} from "../../modules/network/network-interfaces.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get network interfaces procedure
 */
export const getNetworkInterfacesProcedure = authedProcedure
	.output(netifMessageSchema)
	.handler(() => {
		return netIfBuildMsg();
	});

/**
 * Configure network interface procedure
 */
export const configureNetworkInterfaceProcedure = authedProcedure
	.input(netifConfigInputSchema)
	.output(netifConfigOutputSchema)
	.handler(({ input, context }) => {
		handleNetif(context.ws as unknown as import("ws").default, {
			netif: {
				name: input.name,
				ip: input.ip ?? "",
				enabled: input.enabled,
			},
		});
		return { success: true };
	});
