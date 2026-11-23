/**
 * Notifications ORPC Contract
 */
import { oc } from '@orpc/contract';
import {
	notificationDismissInputSchema,
	notificationsMessageSchema,
	successResponseSchema,
} from '../schemas';

export const notificationsContract = oc.router({
	/**
	 * Get persistent notifications
	 */
	getPersistent: oc.output(notificationsMessageSchema),

	/**
	 * Dismiss a notification
	 */
	dismiss: oc.input(notificationDismissInputSchema).output(successResponseSchema),

	/**
	 * Subscribe to notifications
	 */
	onNotification: oc,
});
