/**
 * Dev-only Procedures
 *
 * `dev.emit` triggers an arbitrary backend broadcast on demand so a test client
 * (Playwright) can inject a conflicting `config`/`status` echo at a known time —
 * deterministic QA of the field-lock race-condition fix.
 *
 * Delivery is scoped to the CALLING socket (`only: context.ws`). The echo is for
 * the requesting page alone, preventing an injected state (for example, a
 * `sim_lock` that auto-opens a dialog) from reaching another authenticated page
 * attached to the same worker backend.
 *
 * HARD-GATED: this procedure is only registered when `NODE_ENV !== 'production'`
 * (see ../router.ts). It must never be reachable in a production build.
 */

import {
	devEmitInputSchema,
	devEmitOutputSchema,
	wifiScanInputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { mockWifiRadios, shouldUseMocks } from "../../mocks/mock-service.ts";
import { rebindMockWifi } from "../../mocks/providers/wifi-incarnation.ts";
import { broadcastWifiState } from "../../modules/wifi/wifi.ts";
import { broadcast } from "../events.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Emit an arbitrary broadcast to the calling authenticated client (dev-only).
 * Mirrors the real broadcast envelope (e.g. broadcastMsg("config", config)),
 * but uses a caller-supplied type and payload with socket-scoped delivery.
 */
export const devEmitProcedure = authedProcedure
	.input(devEmitInputSchema)
	.output(devEmitOutputSchema)
	.handler(({ input, context }) => {
		// Defense-in-depth: never emit in production even if somehow registered.
		if (process.env.NODE_ENV === "production") {
			return { success: false };
		}

		broadcast(input.type, input.payload, { only: context.ws });
		return { success: true };
	});

/** Rotate only the mock wire token so E2E can observe a replacement radio. */
export const devRebindWifiProcedure = authedProcedure
	.input(wifiScanInputSchema)
	.output(devEmitOutputSchema)
	.handler(({ input }) => {
		if (process.env.NODE_ENV === "production" || !shouldUseMocks()) {
			return { success: false };
		}
		const radio = mockWifiRadios.find(
			(row, index) =>
				row.device === input.device || String(index) === input.device,
		);
		if (!radio || !rebindMockWifi(radio.device)) return { success: false };
		broadcastWifiState();
		return { success: true };
	});
