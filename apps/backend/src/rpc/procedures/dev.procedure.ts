/**
 * Dev-only Procedures
 *
 * `dev.emit` triggers an arbitrary backend broadcast on demand so a test client
 * (Playwright) can inject a conflicting `config`/`status` echo at a known time —
 * deterministic QA of the field-lock race-condition fix.
 *
 * Delivery is scoped to the CALLING socket (`only: context.ws`). The echo is for
 * the requesting test client alone; fanning it out to every connected client lets
 * one Playwright worker's injected state (e.g. a `sim_lock` that auto-opens a
 * dialog) bleed into another worker's page over the shared dev backend.
 *
 * HARD-GATED: this procedure is only registered when `NODE_ENV !== 'production'`
 * (see ../router.ts). It must never be reachable in a production build.
 */

import { devEmitInputSchema, devEmitOutputSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { broadcast } from "../events.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Emit an arbitrary broadcast to all authenticated clients (dev-only).
 * Mirrors how real broadcasts are sent (e.g. broadcastMsg("config", config)),
 * but with a caller-supplied type + payload.
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
