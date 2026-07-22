/**
 * Notifications Zod schemas
 */
import { z } from 'zod';

import { notificationTypeSchema } from './common.schema';

// Allowlisted, in-app navigation targets a notification may point at. This is a
// TYPED allowlist — NOT a free-form route/URL — so a notification can only ever
// deep-link to a surface the device UI explicitly knows how to open. New targets
// are added here deliberately; the schema rejects anything else. Starts with the
// software-updates dialog (the first consumer, wired by a later change).
export const NOTIFICATION_ACTION_TARGETS = ['updates-dialog'] as const;
export const notificationActionTargetSchema = z.enum(NOTIFICATION_ACTION_TARGETS);
export type NotificationActionTarget = z.infer<typeof notificationActionTargetSchema>;

// Versioned optional action descriptor. `schema` is the descriptor version so the
// shape can evolve additively without breaking older devices/clients (they reject
// an unknown version rather than misinterpret it). `kind: 'navigate'` opens the
// allowlisted `target` in-app; `labelKey` is the i18n key for the affordance copy.
export const notificationActionSchema = z.object({
	schema: z.literal(1),
	kind: z.literal('navigate'),
	target: notificationActionTargetSchema,
	labelKey: z.string(),
});
export type NotificationAction = z.infer<typeof notificationActionSchema>;

// Single notification schema
export const notificationSchema = z.object({
	name: z.string(),
	type: notificationTypeSchema,
	msg: z.string(),
	key: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	is_dismissable: z.boolean(),
	is_persistent: z.boolean(),
	duration: z.number(),
	// Monotonic revision for a persistent notification, so a `remove` can be
	// fenced against a newer `show` (see notificationRemoveSchema). Absent on
	// transient (non-persistent) notifications, which are never removed by id.
	revision: z.number().optional(),
	// Optional, versioned, allowlisted deep-link affordance (additive — legacy
	// producers omit it and keep working unchanged).
	action: notificationActionSchema.optional(),
});
export type Notification = z.infer<typeof notificationSchema>;

// A typed remove entry: `id` is the notification name, `revision` fences it
// against a stale removal (a client ignores a remove whose revision predates the
// notification's current shown revision). Replaces the retired bare-string form.
export const notificationRemoveSchema = z.object({
	id: z.string(),
	revision: z.number(),
});
export type NotificationRemove = z.infer<typeof notificationRemoveSchema>;

// Notifications message schema. Both arrays are optional: a `show` frame carries
// no `remove`, and a `remove`-only frame carries no `show`.
export const notificationsMessageSchema = z.object({
	show: z.array(notificationSchema).optional(),
	remove: z.array(notificationRemoveSchema).optional(),
});
export type NotificationsMessage = z.infer<typeof notificationsMessageSchema>;
