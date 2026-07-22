/**
 * Notification schema tests (device-quality-wave2 Todo 23).
 *
 * Covers the versioned, allowlisted action descriptor and the typed
 * `{ id, revision }` remove message. The action descriptor's `target` is a
 * TYPED allowlist (never a free-form route), so a non-allowlisted target must
 * be rejected by Zod at the schema boundary — the guarantee this suite locks.
 */

import { describe, expect, test } from 'bun:test';

import {
	NOTIFICATION_ACTION_TARGETS,
	notificationActionSchema,
	notificationRemoveSchema,
	notificationSchema,
	notificationsMessageSchema,
} from './notifications.schema';

describe('notification action descriptor (versioned, allowlisted)', () => {
	test('accepts a valid versioned navigate descriptor to an allowlisted target', () => {
		const action = {
			schema: 1,
			kind: 'navigate',
			target: 'updates-dialog',
			labelKey: 'notifications.updateAvailable.action',
		};
		const parsed = notificationActionSchema.parse(action);
		expect(parsed.schema).toBe(1);
		expect(parsed.kind).toBe('navigate');
		expect(parsed.target).toBe('updates-dialog');
		expect(parsed.labelKey).toBe('notifications.updateAvailable.action');
	});

	test('the allowlist starts with exactly updates-dialog', () => {
		expect(NOTIFICATION_ACTION_TARGETS).toContain('updates-dialog');
	});

	test('REJECTS a non-allowlisted (free-form) target', () => {
		const result = notificationActionSchema.safeParse({
			schema: 1,
			kind: 'navigate',
			target: '/settings/software/updates',
			labelKey: 'x',
		});
		expect(result.success).toBe(false);
	});

	test('REJECTS a mismatched descriptor version', () => {
		const result = notificationActionSchema.safeParse({
			schema: 2,
			kind: 'navigate',
			target: 'updates-dialog',
			labelKey: 'x',
		});
		expect(result.success).toBe(false);
	});

	test('REJECTS an unknown kind', () => {
		const result = notificationActionSchema.safeParse({
			schema: 1,
			kind: 'open-url',
			target: 'updates-dialog',
			labelKey: 'x',
		});
		expect(result.success).toBe(false);
	});
});

describe('notification schema carries the OPTIONAL action descriptor', () => {
	const base = {
		name: 'update',
		type: 'success' as const,
		msg: 'An update is available',
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
	};

	test('a legacy notification without an action still parses (additive-optional)', () => {
		const parsed = notificationSchema.parse(base);
		expect(parsed.action).toBeUndefined();
	});

	test('a notification with a valid action parses', () => {
		const parsed = notificationSchema.parse({
			...base,
			action: {
				schema: 1,
				kind: 'navigate',
				target: 'updates-dialog',
				labelKey: 'notifications.updateAvailable.action',
			},
		});
		expect(parsed.action?.target).toBe('updates-dialog');
	});

	test('a notification with a non-allowlisted action target is rejected', () => {
		const result = notificationSchema.safeParse({
			...base,
			action: {
				schema: 1,
				kind: 'navigate',
				target: 'evil-route',
				labelKey: 'x',
			},
		});
		expect(result.success).toBe(false);
	});
});

describe('typed remove message { id, revision }', () => {
	test('accepts a well-formed { id, revision } entry', () => {
		const parsed = notificationRemoveSchema.parse({ id: 'update', revision: 7 });
		expect(parsed.id).toBe('update');
		expect(parsed.revision).toBe(7);
	});

	test('rejects a bare string id (the retired untyped shape)', () => {
		expect(notificationRemoveSchema.safeParse('update').success).toBe(false);
	});

	test('rejects a remove entry missing its revision', () => {
		expect(notificationRemoveSchema.safeParse({ id: 'update' }).success).toBe(false);
	});

	test('notifications message parses a remove-only frame', () => {
		const parsed = notificationsMessageSchema.parse({
			remove: [{ id: 'update', revision: 3 }],
		});
		expect(parsed.remove?.[0]?.id).toBe('update');
		expect(parsed.show).toBeUndefined();
	});

	test('notifications message parses a show-only frame', () => {
		const parsed = notificationsMessageSchema.parse({
			show: [
				{
					name: 'update',
					type: 'success',
					msg: 'ready',
					is_dismissable: true,
					is_persistent: true,
					duration: 0,
				},
			],
		});
		expect(parsed.show?.[0]?.name).toBe('update');
		expect(parsed.remove).toBeUndefined();
	});
});
