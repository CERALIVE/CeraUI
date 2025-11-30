/**
 * Notifications Procedures
 * Wraps existing notifications logic from modules/ui/notifications.ts
 */

import {
	notificationsMessageSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { z } from "zod";

import {
	notificationExists,
	notificationRemove,
} from "../../modules/ui/notifications.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get persistent notifications procedure
 */
export const getPersistentNotificationsProcedure = authedProcedure
	.output(notificationsMessageSchema)
	.handler(() => {
		// Note: This returns an empty array since persistent notifications
		// are typically sent as part of the initial status on connection.
		// For now, we return an empty show array.
		return { show: [] };
	});

/**
 * Dismiss a notification procedure
 */
export const dismissNotificationProcedure = authedProcedure
	.input(z.object({ name: z.string() }))
	.output(successResponseSchema)
	.handler(({ input }) => {
		const { name } = input;

		// Check if notification exists before removing
		const exists = notificationExists(name);
		if (exists) {
			notificationRemove(name);
		}

		return { success: true };
	});
