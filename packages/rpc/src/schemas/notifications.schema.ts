/**
 * Notifications Zod schemas
 */
import { z } from 'zod';

import { notificationTypeSchema } from './common.schema';

// Single notification schema
export const notificationSchema = z.object({
	name: z.string(),
	type: notificationTypeSchema,
	msg: z.string(),
	is_dismissable: z.boolean(),
	is_persistent: z.boolean(),
	duration: z.number(),
});
export type Notification = z.infer<typeof notificationSchema>;

// Notifications message schema
export const notificationsMessageSchema = z.object({
	show: z.array(notificationSchema),
});
export type NotificationsMessage = z.infer<typeof notificationsMessageSchema>;
