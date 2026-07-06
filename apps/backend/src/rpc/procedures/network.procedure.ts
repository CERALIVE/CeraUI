/**
 * Network Interface Procedures
 * Wraps existing network logic from modules/network/
 */

import {
	NETWORK_INGEST_UNAVAILABLE_ERROR,
	netifConfigInputSchema,
	netifConfigOutputSchema,
	netifMessageSchema,
	setIngestEnabledInputSchema,
	setIngestEnabledOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import {
	setMockNetifConfig,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import { setMockNetworkIngestActive } from "../../mocks/providers/network-ingest.ts";
import { setMockGatewayActive } from "../../mocks/providers/streaming.ts";
import { refreshAndBroadcastNetworkIngest } from "../../modules/network/network-ingest.ts";
import {
	persistIngestDesired,
	setIngestEnabled,
} from "../../modules/network/network-ingest-control.ts";
import {
	handleNetif,
	netIfBuildMsg,
} from "../../modules/network/network-interfaces.ts";
import { broadcastSources } from "../../modules/streaming/sources.ts";
import { isRealDevice } from "../../modules/system/device-detection.ts";
import { broadcastMsg } from "../compat.ts";
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
			// handleNetif's own netif broadcast is skipped in mock mode: its raw
			// netif-map IP differs from the mock-overlaid IP the client echoes, so
			// the IP-match guard early-returns before broadcasting. Emit the
			// overlaid state here so bonded-link cards react to the toggle
			// immediately instead of on the next 5s poll.
			broadcastMsg("netif", netIfBuildMsg());
		}

		handleNetif(context.ws as unknown as import("ws").default, {
			name: input.name,
			ip: input.ip ?? "",
			enabled: input.enabled,
		});

		return {
			success: true,
			applied: { name: input.name, ip: input.ip, enabled: input.enabled },
		};
	});

/**
 * Enable/disable a LAN RTMP/SRT network-ingest gateway (operator desired state).
 *
 * Branch order is normative:
 *   1. mocks — persist the desired state + flip BOTH mock signals (status +
 *      start-gate), rebroadcast, ZERO process spawns (dev/e2e parity);
 *   2. emulated non-mock — the systemd units do not exist → UNAVAILABLE, no spawns;
 *   3. real device — persist → reconcile units → refresh (in setIngestEnabled).
 */
export const setNetworkIngestEnabledProcedure = authedProcedure
	.input(setIngestEnabledInputSchema)
	.output(setIngestEnabledOutputSchema)
	.handler(async ({ input }) => {
		const { protocol, enabled } = input;

		if (shouldUseMocks()) {
			persistIngestDesired(protocol, enabled);
			setMockNetworkIngestActive(protocol, enabled);
			setMockGatewayActive(protocol, enabled);
			await refreshAndBroadcastNetworkIngest();
			broadcastSources();
			return { success: true, applied: { protocol, enabled } };
		}

		if (!(await isRealDevice())) {
			return { success: false, error: NETWORK_INGEST_UNAVAILABLE_ERROR };
		}

		return setIngestEnabled(protocol, enabled);
	});
