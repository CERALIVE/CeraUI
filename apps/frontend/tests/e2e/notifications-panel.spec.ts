import fs from 'node:fs';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { EVIDENCE_DIR, navigateTo } from './helpers/index.js';

/**
 * Task 16 — Persistent-notifications panel, integrated E2E (mock backend).
 *
 * Proves the panel surfaced from the header lists `getPersistent()` (distinct
 * from the transient toast stream), carries an unread-count badge, and lets the
 * operator dismiss an item live:
 *
 *   notifications: two persistent items injected via the real `notifications`
 *     broadcast (dev.emit) render in the panel with a "2" badge; dismissing one
 *     drops it from the list and decrements the badge to "1".
 *   empty: with no persistent notifications the panel shows its empty state and
 *     the badge is absent.
 *
 * Auth + harness mirrors relay-notifications.spec.ts: the authed socket is
 * wrapped via addInitScript so the test authenticates with a persistent TOKEN
 * (read from the backend's auth_tokens.json) instead of the device password.
 *
 * Backend broadcasts reach EVERY authed client, so each test clears the shared
 * store first (clearNotifications) for deterministic, leak-free counts.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(import.meta.dirname, '../../../backend/auth_tokens.json');
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`);
	}
	return tokens[0];
})();

test.describe.configure({ mode: 'serial' });

const evidence = new Map<string, string[]>();
function record(file: string, line: string): void {
	if (!evidence.has(file)) evidence.set(file, []);
	evidence.get(file)?.push(line);
	console.log(`[task-16] ${line}`);
}

test.afterAll(() => {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	for (const [file, lines] of evidence) {
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, file),
			[
				'Task 16 — Persistent-notifications panel E2E',
				'Driver: real frontend + real dev backend (mock multi-modem-wifi),',
				'        persistent notifications injected via dev.emit, store + DOM read in-page.',
				`Generated: ${new Date().toISOString()}`,
				'',
				...lines,
				'',
			].join('\n'),
			'utf8',
		);
	}
});

/**
 * Browser-side WebSocket harness: rewrites `auth.login` to a persistent token so
 * the test authenticates without the device password (mirrors the model spec).
 */
function installWsHarness(opts: { token: string }): void {
	const Native = window.WebSocket;

	class HookedWebSocket extends Native {
		send(data: string | Blob | BufferSource): void {
			if (typeof data === 'string') {
				try {
					const msg = JSON.parse(data);
					if (Array.isArray(msg.path) && msg.path.join('.') === 'auth.login') {
						msg.input = { token: opts.token, persistent_token: true };
						super.send(JSON.stringify(msg));
						return;
					}
				} catch {
					/* not an RPC frame (e.g. keepalive) */
				}
			}
			super.send(data);
		}
	}

	window.WebSocket = HookedWebSocket as typeof WebSocket;
	try {
		localStorage.setItem('auth', 'e2e-token-marker');
	} catch {
		/* localStorage unavailable */
	}
}

interface PersistentLite {
	name: string;
	text: string;
	type: string;
}

/** Read the persistent slice of the central notification store. */
function readPersistent(page: Page): Promise<PersistentLite[]> {
	return page.evaluate(async () => {
		const specPath = '/src/lib/stores/notifications.svelte.ts';
		const mod = await import(/* @vite-ignore */ specPath);
		return mod
			.getPersistent()
			.map((n: { name: string; text: string; type: string }) => ({
				name: n.name,
				text: n.text,
				type: n.type,
			}));
	});
}

/** Reset the shared store so each test starts from a known-empty baseline. */
function clearStore(page: Page): Promise<void> {
	return page.evaluate(async () => {
		const specPath = '/src/lib/stores/notifications.svelte.ts';
		const mod = await import(/* @vite-ignore */ specPath);
		mod.clearNotifications();
	});
}

/** Inject a persistent notification through the real `notifications` broadcast. */
function emitPersistent(page: Page, notification: Record<string, unknown>): Promise<void> {
	return page.evaluate(async (n) => {
		const specPath = '/src/lib/rpc/client.ts';
		const mod = await import(/* @vite-ignore */ specPath);
		await mod.rpc.dev.emit({ type: 'notifications', payload: { show: [n] } });
	}, notification);
}

function persistent(name: string, msg: string): Record<string, unknown> {
	return {
		name,
		type: 'warning',
		msg,
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
	};
}

test.beforeEach(async ({ page, browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the header panel');
	await page.addInitScript(installWsHarness, { token: TOKEN });
	await page.goto('/');
	await navigateTo(page, 'live');
	await clearStore(page);
});

test('persistent notifications list with an unread badge; dismiss removes one and decrements', async ({
	page,
}) => {
	await emitPersistent(page, persistent('task16-persist-1', 'Persistent device alert one'));
	await emitPersistent(page, persistent('task16-persist-2', 'Persistent device alert two'));

	await expect.poll(() => readPersistent(page).then((p) => p.length), {
		message: 'both persistent notifications should land in the store',
	}).toBe(2);

	// Header badge reflects the unread count before opening the panel.
	const badge = page.getByTestId('notifications-unread-count');
	await expect(badge).toHaveText('2');

	await page.getByTestId('notifications-bell').click();
	const dialog = page.getByRole('dialog', { name: 'Notifications' });
	await expect(dialog).toBeVisible();

	const items = dialog.getByTestId('notification-item');
	await expect(items).toHaveCount(2);
	await expect(dialog.locator('[data-notification="task16-persist-1"]')).toBeVisible();
	await expect(dialog.locator('[data-notification="task16-persist-2"]')).toBeVisible();
	record('task-16-notifications.txt', 'Two persistent notifications listed; header badge = "2" ✓');

	// Dismiss the first item — it leaves the list and the badge decrements.
	await dialog
		.locator('[data-notification="task16-persist-1"]')
		.getByTestId('notification-dismiss')
		.click();

	await expect(dialog.locator('[data-notification="task16-persist-1"]')).toHaveCount(0);
	await expect(dialog.locator('[data-notification="task16-persist-2"]')).toBeVisible();
	await expect(items).toHaveCount(1);
	await expect(badge).toHaveText('1');

	const remaining = await readPersistent(page);
	expect(remaining.map((n) => n.name)).toEqual(['task16-persist-2']);
	record(
		'task-16-notifications.txt',
		`Dismissed task16-persist-1 → list count 2→1, badge 2→1, store remainder=${JSON.stringify(
			remaining.map((n) => n.name),
		)} ✓`,
	);
});

test('empty state renders when there are no persistent notifications', async ({ page }) => {
	await expect.poll(() => readPersistent(page).then((p) => p.length), {
		message: 'store should be empty after clear',
	}).toBe(0);

	// No outstanding notifications → no header badge.
	await expect(page.getByTestId('notifications-unread-count')).toHaveCount(0);

	await page.getByTestId('notifications-bell').click();
	const dialog = page.getByRole('dialog', { name: 'Notifications' });
	await expect(dialog).toBeVisible();

	await expect(dialog.getByTestId('notifications-empty')).toBeVisible();
	await expect(dialog.getByTestId('notification-item')).toHaveCount(0);
	await expect(dialog.getByText("You're all caught up")).toBeVisible();
	record(
		'task-16-empty.txt',
		'No persistent notifications → empty state shown, list empty, header badge absent ✓',
	);
});
