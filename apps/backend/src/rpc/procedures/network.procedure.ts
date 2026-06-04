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
	setMockNetifConfig,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
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
		// Order is load-bearing: persist the mock overlay BEFORE handleNetif,
		// whose synchronous netif broadcasts overlay `enabled`/`ip` from it via
		// netIfBuildMsg. Writing first makes those broadcasts carry the new
		// value, not the stale prior one. (undefined IP === DHCP.)
		if (shouldUseMocks()) {
			setMockNetifConfig(input.name, {
				enabled: input.enabled,
				dhcp: input.ip === undefined,
				ip: input.ip,
			});
		}

		handleNetif(context.ws as unknown as import("ws").default, {
			netif: {
				name: input.name,
				ip: input.ip ?? "",
				enabled: input.enabled,
			},
		});

		return {
			success: true,
			applied: { name: input.name, ip: input.ip, enabled: input.enabled },
		};
	});
