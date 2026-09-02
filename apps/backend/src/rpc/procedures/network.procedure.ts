/**
 * Network Interface Procedures
 * Wraps existing network logic from modules/network/
 */

import {
	NETWORK_INGEST_UNAVAILABLE_ERROR,
	netifConfigInputSchema,
	netifConfigOutputSchema,
	netifMessageSchema,
	setEthernetRoleInputSchema,
	setEthernetRoleOutputSchema,
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
import { setEthernetRole } from "../../modules/network/ethernet-role-transition.ts";
import { refreshAndBroadcastNetworkIngest } from "../../modules/network/network-ingest.ts";
import {
	persistIngestDesired,
	setIngestEnabled,
} from "../../modules/network/network-ingest-control.ts";
import {
	getNetworkInterfaces,
	handleNetif,
	netIfBuildMsg,
	readAppliedNetifConfig,
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
			// Publish the overlay before the raw-map mutation so bonded-link cards
			// react immediately instead of waiting for the next 5 s poll.
			broadcastMsg("netif", netIfBuildMsg());
		}

		const observedIp = shouldUseMocks()
			? getNetworkInterfaces()[input.name]?.ip
			: input.ip;
		const outcome = handleNetif(context.ws as unknown as import("ws").default, {
			name: input.name,
			ip: observedIp ?? "",
			enabled: input.enabled,
		});

		// Under mocks the overlay is authoritative; the raw-map mutation remains a
		// best effort so dev/e2e reflects the same immediate applied readback.
		if (!shouldUseMocks() && !outcome.ok) {
			return { success: false, error: outcome.reason };
		}

		const applied = shouldUseMocks()
			? readAppliedNetifConfig(input.name)
			: outcome.ok
				? outcome.applied
				: undefined;
		if (applied === undefined) {
			return { success: false, error: "unknown_interface" as const };
		}
		return {
			success: true,
			applied,
		};
	});

/**
 * Declare an Ethernet port's role.
 *
 * Emulated hosts are refused BEFORE anything is persisted: there is no
 * NetworkManager profile to rewrite, so persisting a role the device could never
 * apply would leave the boot reconciler chasing it forever.
 */
export const setEthernetRoleProcedure = authedProcedure
	.input(setEthernetRoleInputSchema)
	.output(setEthernetRoleOutputSchema)
	.handler(async ({ input }) => {
		if (!shouldUseMocks() && !(await isRealDevice())) {
			return { success: false, error: "unavailable_in_emulated_mode" as const };
		}

		return setEthernetRole(input.name, input.role);
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
