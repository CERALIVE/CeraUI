/**
 * Notifications ORPC Contract
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';
import { notificationsMessageSchema, successResponseSchema } from '../schemas';

export const notificationsContract = oc.router({
	/**
	 * Get persistent notifications
	 */
	getPersistent: oc.output(notificationsMessageSchema),

	/**
	 * Dismiss a notification
	 */
	dismiss: oc.input(z.object({ name: z.string() })).output(successResponseSchema),

	/**
	 * Subscribe to notifications
	 */
	onNotification: oc.route({ method: 'GET', path: '/notifications' }),
});
