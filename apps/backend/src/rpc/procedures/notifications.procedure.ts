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
	getPersistentNotifications,
	notificationDismiss,
	notificationExists,
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
		// authedProcedure guarantees an authenticated socket, so authed-only
		// persistent notifications are included. The frontend NotificationsPanel
		// reads the live `notification` push cache; this RPC is the pull-equivalent
		// (same data) for any consumer that asks for the snapshot directly.
		return getPersistentNotifications(true);
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
			notificationDismiss(name);
		}

		return { success: true };
	});
