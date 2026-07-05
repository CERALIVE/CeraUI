/**
 * Authentication Middleware
 * Ensures the socket is authenticated before proceeding
 */
import { ORPCError, os } from "@orpc/server";

import type { RPCContext } from "../types.ts";

/**
 * Middleware that requires authentication
 * Throws an error if the socket is not authenticated
 *
 * Built through the oRPC builder (`os.$context<RPCContext>().middleware`) so its
 * type matches the `Middleware<RPCContext, …>` shape `baseProcedure.use()` expects
 * — a hand-rolled `{ context, next }` signature does NOT satisfy oRPC's
 * `MiddlewareOptions`/`MiddlewareResult` contract and makes every authed procedure
 * (and the assembled router) fail assignability.
 */
export const authMiddleware = os
	.$context<RPCContext>()
	.middleware(async ({ context, next }) => {
		if (!context.isAuthenticated()) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Authentication required",
			});
		}

		// Update last active timestamp
		context.markActive();

		return next();
	});
