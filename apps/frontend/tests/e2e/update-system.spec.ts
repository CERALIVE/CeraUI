import type { Page } from '@playwright/test';

import type { UpdateSettings } from '@ceraui/rpc/schemas';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import {
	CAPABLE_CAPABILITIES,
	CELLULAR_IMAGE_ID,
	LEGACY_CAPABILITIES,
	capableDetails,
	installUpdateWire,
	orchestratorState,
} from './helpers/update-wire.js';

/**
 * Todo 41 — the device update surfaces, @functional.
 *
 * Driven against the REAL worker backend (auth, settings persistence, the
 * status stream) with the orchestrator state and the dialog's capability /
 * detail reads supplied by `helpers/update-wire.ts`, because a dev worker's
 * orchestrator never leaves `idle`. Every assertion is on roles, accessible
 * names or test ids — no screenshots (those live in
 * `visual/update-system.visual.spec.ts`).
 */

const UPDATES_DIALOG = 'Software Updates';

async function boot(page: Page): Promise<void> {
	await page.goto('/');
	await ensureAuthenticated(page);
}

async function openUpdatesDialog(page: Page) {
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-updates').click();
	const dialog = page.getByRole('dialog', { name: UPDATES_DIALOG });
	await expect(dialog).toBeVisible();
	// The reads land before any section renders; the skeleton says so.
	await expect(dialog.getByTestId('update-details-loading')).toHaveCount(0);
	return dialog;
}

test.describe('device update surfaces (Todo 41)', { tag: '@functional' }, () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser integration proof');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the settings dialog');
	});

	test('the Go-Live band follows the live orchestrator phase and never disables Start', async ({
		page,
	}) => {
		const wire = await installUpdateWire(page, {
			orchestrator: orchestratorState('committing', { percent: 64, etaSeconds: 150 }),
			startable: true,
		});
		await boot(page);
		await navigateTo(page, 'live');
		wire.pushStartable();

		const band = page.getByTestId('update-refusal-band');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('data-source', 'live');
		await expect(band.getByTestId('update-refusal-phase')).toHaveText('Installing packages');
		await expect(band.getByTestId('update-refusal-percent')).toHaveText('64%');
		await expect(band.getByTestId('update-refusal-eta')).toHaveText('About 3 min left');
		await expect(band.getByRole('progressbar')).toBeVisible();

		// The backend stays the authority on admission: the band warns, it does
		// not take the control away.
		await expect(page.getByRole('button', { name: 'Start Stream' })).toBeEnabled();

		// Restarting services refuses a start too, and says so by name.
		wire.setOrchestrator(orchestratorState('restarting-services'));
		await expect(band.getByTestId('update-refusal-phase')).toHaveText('Restarting services');
		await expect(band.getByTestId('update-refusal-percent')).toHaveCount(0);

		// The moment the phase moves on, the band goes away by itself.
		wire.setOrchestrator(orchestratorState('settled'));
		await expect(page.getByTestId('update-refusal-band')).toHaveCount(0);
	});

	test('a typed update_in_progress refusal renders the band when the backend publishes no state', async ({
		page,
	}) => {
		const wire = await installUpdateWire(page, {
			orchestrator: null,
			startable: true,
			fakes: {
				'streaming.start': {
					success: false,
					is_streaming: false,
					result: 'failed',
					attemptId: 'e2e-update-attempt',
					error: 'update_in_progress',
					failure: {
						attemptId: 'e2e-update-attempt',
						phase: 'params',
						class: 'update_in_progress',
						updatePhase: 'committing',
						updatePercent: 41.6,
						updateEtaSeconds: 90,
						retriable: false,
					},
				},
			},
		});
		await boot(page);
		await navigateTo(page, 'live');
		wire.pushStartable();

		await expect(page.getByTestId('update-refusal-band')).toHaveCount(0);
		const start = page.getByRole('button', { name: 'Start Stream' });
		await expect(start).toBeEnabled();
		await start.click();

		const band = page.getByTestId('update-refusal-band');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('data-source', 'refusal');
		await expect(band.getByTestId('update-refusal-phase')).toHaveText('Installing packages');
		await expect(band.getByTestId('update-refusal-percent')).toHaveText('42%');
		await expect(band.getByTestId('update-refusal-eta')).toHaveText('About 2 min left');
		expect(wire.calls('streaming.start')).toHaveLength(1);
	});

	test('the global badge shows a busy phase anywhere, opens the dialog, and retracts', async ({
		page,
	}) => {
		const wire = await installUpdateWire(page, {
			orchestrator: orchestratorState('downloading', { percent: 42, etaSeconds: 300 }),
			fakes: {
				'system.getUpdateCapabilities': LEGACY_CAPABILITIES,
			},
		});
		await boot(page);
		await navigateTo(page, 'network');

		const badge = page.getByTestId('update-orchestrator-badge');
		await expect(badge).toBeVisible();
		await expect(badge).toHaveAttribute('data-phase', 'downloading');
		await expect(badge.getByTestId('update-orchestrator-badge-phase')).toHaveText(
			'Downloading packages',
		);
		await expect(badge.getByTestId('update-orchestrator-badge-percent')).toHaveText('42%');

		// The visible phase and progress stay in the button's accessible name.
		const button = badge.getByRole('button', { name: /Downloading packages/ });
		await expect(button).toHaveAccessibleName(/42%/);
		await button.click();
		const dialog = page.getByRole('dialog', { name: UPDATES_DIALOG });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByTestId('update-activity')).toHaveAttribute('data-phase', 'downloading');
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();

		// A resting phase is nothing to announce app-wide.
		wire.setOrchestrator(orchestratorState('idle'));
		await expect(page.getByTestId('update-orchestrator-badge')).toHaveCount(0);
	});

	test('an automation toggle persists on the device across a reload', async ({ page, backendRpc }) => {
		await installUpdateWire(page);
		await boot(page);

		const before = await backendRpc.call<UpdateSettings>(['system', 'getUpdateSettings']);
		expect(before.packagesAuto).toBe(true);

		let dialog = await openUpdatesDialog(page);
		const toggle = dialog.getByRole('switch', { name: 'Install package updates automatically' });
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await toggle.click();
		// Pessimistic: it moves only to what the device echoed back.
		await expect(toggle).toHaveAttribute('aria-checked', 'false');

		const after = await backendRpc.call<UpdateSettings>(['system', 'getUpdateSettings']);
		expect(after.packagesAuto).toBe(false);

		await page.reload();
		await ensureAuthenticated(page);
		dialog = await openUpdatesDialog(page);
		await expect(
			dialog.getByRole('switch', { name: 'Install package updates automatically' }),
		).toHaveAttribute('aria-checked', 'false');
	});

	test('a schedule window is validated before it can be saved, then persisted', async ({
		page,
		backendRpc,
	}) => {
		await installUpdateWire(page);
		await boot(page);
		const dialog = await openUpdatesDialog(page);

		await dialog.getByTestId('update-schedule-mode-window').click();
		await dialog.getByTestId('update-schedule-start').fill('05:00');
		await dialog.getByTestId('update-schedule-end').fill('03:00');

		const error = dialog.getByTestId('update-schedule-error');
		await expect(error).toBeVisible();
		await expect(error).toHaveAttribute('data-error', 'end-before-start');
		await expect(error).toHaveAttribute('role', 'alert');
		const save = dialog.getByTestId('update-schedule-save');
		await expect(save).toBeDisabled();

		// Saying the window runs past midnight is what makes the times coherent.
		await dialog.getByTestId('update-schedule-midnight').click();
		await expect(error).toHaveCount(0);
		await expect(save).toBeEnabled();
		await save.click();

		await expect
			.poll(async () =>
				(await backendRpc.call<UpdateSettings>(['system', 'getUpdateSettings'])).schedule,
			)
			.toEqual({ mode: 'window', start: '05:00', end: '03:00' });
		// Saved = no longer dirty, so the save control retires.
		await expect(dialog.getByTestId('update-schedule-save')).toHaveCount(0);
	});

	test('a held system image names its real size and is approved for exactly that candidate', async ({
		page,
	}) => {
		const wire = await installUpdateWire(page, {
			fakes: {
				'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
				'system.getUpdateDetails': capableDetails(),
				'system.allowCellularOnce': { success: true },
				'system.installUpdatesNow': { success: true },
			},
		});
		await boot(page);
		const dialog = await openUpdatesDialog(page);

		const pending = dialog.getByTestId('update-cellular-pending');
		await expect(pending).toBeVisible();
		await expect(pending).toHaveAttribute('data-pending-id', CELLULAR_IMAGE_ID);
		await expect(dialog.getByTestId('update-cellular-pending-body')).toContainText('700 MB');
		await expect(dialog.getByTestId('update-cellular-pending-body')).toContainText(CELLULAR_IMAGE_ID);

		await dialog.getByTestId('update-cellular-approve').click();
		await expect.poll(() => wire.calls('system.allowCellularOnce')).toEqual([{ id: CELLULAR_IMAGE_ID }]);
		await expect.poll(() => wire.calls('system.installUpdatesNow').length).toBe(1);
		await expect(dialog.getByTestId('update-action-refused')).toHaveCount(0);
	});

	test('a legacy image says what it cannot do and hides the system-image surfaces', async ({
		page,
	}) => {
		await installUpdateWire(page, {
			fakes: { 'system.getUpdateCapabilities': LEGACY_CAPABILITIES },
		});
		await boot(page);
		const dialog = await openUpdatesDialog(page);

		await expect(dialog.getByTestId('update-legacy-notice')).toBeVisible();
		await expect(dialog.getByTestId('updates-system')).toHaveCount(0);
		await expect(dialog.getByTestId('updates-slots')).toHaveCount(0);
		await expect(dialog.getByTestId('update-channel')).toHaveCount(0);
		await expect(dialog.getByTestId('update-cellular-system')).toHaveCount(0);
		// Package automation works on every image.
		await expect(dialog.getByTestId('updates-automation')).toBeVisible();
		await expect(dialog.getByTestId('updates-packages')).toBeVisible();
	});

	test('a capable image renders every section and no legacy notice', async ({ page }) => {
		await installUpdateWire(page, {
			fakes: {
				'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
				'system.getUpdateDetails': capableDetails({ pendingCellular: null }),
			},
		});
		await boot(page);
		const dialog = await openUpdatesDialog(page);

		await expect(dialog.getByTestId('update-legacy-notice')).toHaveCount(0);
		await expect(dialog.getByTestId('updates-system')).toBeVisible();
		await expect(dialog.getByTestId('updates-slots')).toBeVisible();
		await expect(dialog.getByTestId('update-slot-A')).toHaveAttribute('data-slot-state', 'booted');
		await expect(dialog.getByTestId('update-slot-B')).toBeVisible();
		await expect(dialog.getByTestId('update-channel')).toBeVisible();
		await expect(dialog.getByTestId('updates-connection')).toBeVisible();
		await expect(dialog.getByTestId('update-cellular-pending')).toHaveCount(0);
	});
});
