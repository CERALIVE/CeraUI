import fs from 'node:fs';
import path from 'node:path';

import { expect, type PageRpc, test } from './fixtures/index.js';

import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from './helpers/index.js';

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
 * Browser contexts are fresh per test. The backend is scoped to and reused by
 * the Playwright worker, so UI state resets between tests while backend state
 * remains isolated by worker.
 */

const evidence = new Map<string, string[]>();
function record(file: string, line: string): void {
	if (!evidence.has(file)) evidence.set(file, []);
	evidence.get(file)?.push(line);
}

test.afterAll(() => {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	for (const [file, lines] of evidence) {
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, file),
			[
				'Task 16 — Persistent-notifications panel E2E',
				'Driver: real frontend + real dev backend (mock multi-modem-wifi),',
				'        persistent notifications injected via dev.emit and asserted through the UI.',
				`Generated: ${new Date().toISOString()}`,
				'',
				...lines,
				'',
			].join('\n'),
			'utf8',
		);
	}
});

// Wire type is SINGULAR `notification` — the type the backend actually
// broadcasts and the only one subscriptions.svelte.ts folds into the store.
// (Plural `notifications` lands nowhere since fa7f0277 renamed the handler.)
function emitPersistent(
	pageRpc: PageRpc,
	notification: Record<string, unknown>,
): Promise<unknown> {
	return pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: { show: [notification] },
	});
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

test.beforeEach(async ({ page, pageRpc, browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the header panel');
	void pageRpc;
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
});

test('persistent notifications list with an unread badge; dismiss removes one and decrements', async ({
	page,
	pageRpc,
}) => {
	await emitPersistent(pageRpc, persistent('task16-persist-1', 'Persistent device alert one'));
	await emitPersistent(pageRpc, persistent('task16-persist-2', 'Persistent device alert two'));

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

	record(
		'task-16-notifications.txt',
		'Dismissed task16-persist-1 → list count 2→1, badge 2→1, task16-persist-2 remains ✓',
	);
});

test('empty state renders when there are no persistent notifications', async ({ page }) => {
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
