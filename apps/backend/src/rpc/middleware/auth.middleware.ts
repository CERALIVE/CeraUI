/**
 * Authentication Middleware
 * Ensures the socket is authenticated before proceeding
 */
import { ORPCError } from "@orpc/server";

import type { RPCContext } from "../types.ts";

/**
 * Middleware that requires authentication
 * Throws an error if the socket is not authenticated
 */
export const authMiddleware = async ({
	context,
	next,
}: {
	context: RPCContext;
	next: () => Promise<unknown>;
}) => {
	if (!context.isAuthenticated()) {
		throw new ORPCError("UNAUTHORIZED", "Authentication required");
	}

	// Update last active timestamp
	context.markActive();

	return next();
};
