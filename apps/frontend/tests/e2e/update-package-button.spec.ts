import type { Page } from '@playwright/test';
import type { UpdateState } from '@ceraui/rpc/schemas';
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import { CAPABLE_CAPABILITIES, LEGACY_CAPABILITIES, capableDetails, installUpdateWire, orchestratorState } from './helpers/update-wire.js';

const packages: UpdateState = { kind: 'available', identity: { version: 'pkg', packages: ['cerastream'] }, package_count: 1, actionable_count: 1 };

async function confirmPackages(page: Page): Promise<void> {
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-updates').click();
	await expect(page.getByTestId('update-details-loading')).toHaveCount(0);
	await page.getByTestId('update-install').click();
	await page.getByRole('dialog', { name: 'Are you absolutely sure?' }).getByRole('button', { name: 'Update', exact: true }).click();
}

test('package button drives scoped progress, global badge, Go Live band and installed notice @functional', async ({ page }) => {
	// Given a capable package offer on the same mock backend used by update-system.
	const wire = await installUpdateWire(page, { packages, orchestrator: orchestratorState('available'), startable: true, fakes: {
		'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
		'system.getUpdateDetails': capableDetails(),
		'system.installUpdatesNow': { success: true },
	} });
	// When the package confirmation is accepted, then the exact scoped RPC is sent.
	await confirmPackages(page);
	await expect.poll(() => wire.calls('system.installUpdatesNow')).toEqual([{ scope: 'packages' }]);
	expect(wire.calls('system.startUpdate')).toEqual([]);
	wire.setOrchestrator(orchestratorState('downloading', { percent: 42, etaSeconds: 90 }));
	await expect(page.getByTestId('update-activity')).toHaveAttribute('data-phase', 'downloading');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('update-orchestrator-badge')).toHaveAttribute('data-phase', 'downloading');
	await navigateTo(page, 'live');
	wire.setOrchestrator(orchestratorState('committing', { percent: 64, etaSeconds: 30 }));
	await expect(page.getByTestId('update-refusal-band')).toBeVisible();
	await expect(page.getByTestId('update-refusal-phase')).toHaveText('Installing packages');
	wire.pushNotification({ name: 'update:installed:package-button', type: 'success', msg: 'notifications.updateInstalled', key: 'notifications.updateInstalled', params: { packages: 'cerastream' }, is_dismissable: true, is_persistent: true, duration: 0 });
	wire.setOrchestrator(orchestratorState('settled'));
	await expect(page.getByTestId('update-refusal-band')).toHaveCount(0);
	await page.getByTestId('notifications-bell').click();
	await expect(page.getByTestId('notification-item').filter({ hasText: 'cerastream' })).toBeVisible();
});

for (const regime of ['os-available', 'legacy'] as const) {
	test(`package button keeps legacy RPC with ${regime} @functional`, async ({ page }) => {
		// Given a state for which the legacy package route is intentionally retained.
		const wire = await installUpdateWire(page, { packages, orchestrator: orchestratorState(regime === 'os-available' ? 'os-available' : 'available'), fakes: {
			'system.getUpdateCapabilities': regime === 'legacy' ? LEGACY_CAPABILITIES : CAPABLE_CAPABILITIES,
			'system.getUpdateDetails': capableDetails(),
			'system.startUpdate': { success: true },
		} });
		// When packages are confirmed, then only the legacy RPC is dispatched.
		await confirmPackages(page);
		await expect.poll(() => wire.calls('system.startUpdate').length).toBe(1);
		expect(wire.calls('system.installUpdatesNow')).toEqual([]);
	});
}

test('package button waits for a phase before scoped install @functional', async ({ page }) => {
	// Given a capable declaration but no orchestrator phase in the initial hydrate.
	const wire = await installUpdateWire(page, { packages, orchestrator: null, fakes: {
		'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
		'system.getUpdateDetails': capableDetails(),
		'system.installUpdatesNow': { success: true },
	} });
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-updates').click();
	await expect(page.getByRole('dialog', { name: 'Software Updates' })).toBeVisible();
	await expect(page.getByTestId('update-details-loading')).toHaveCount(0);
	const install = page.getByTestId('update-install');
	await expect(install).toBeDisabled();
	expect(wire.calls('system.startUpdate')).toEqual([]);
	expect(wire.calls('system.installUpdatesNow')).toEqual([]);
	// When the phase arrives, the same control enables and the operator confirms.
	wire.setOrchestrator(orchestratorState('available'));
	await expect(install).toBeEnabled();
	await install.click();
	await page.getByRole('dialog', { name: 'Are you absolutely sure?' }).getByRole('button', { name: 'Update', exact: true }).click();
	// Then exactly one package-scoped request is sent, never a legacy request.
	await expect.poll(() => wire.calls('system.installUpdatesNow')).toEqual([{ scope: 'packages' }]);
	expect(wire.calls('system.startUpdate')).toEqual([]);
});

test('scoped server refusal re-enables package control without legacy fallback @functional', async ({ page }) => {
	// Given a package phase at click time but refusal at server admission.
	const wire = await installUpdateWire(page, { packages, orchestrator: orchestratorState('available'), fakes: {
		'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
		'system.getUpdateDetails': capableDetails(),
		'system.installUpdatesNow': { success: false, error: 'not_available' },
	} });
	// When the scoped server refuses, then existing feedback leaves retry available.
	await confirmPackages(page);
	await expect(page.getByTestId('update-action-refused')).toHaveAttribute('data-action', 'install');
	await expect(page.getByTestId('update-install')).toBeEnabled();
	expect(wire.calls('system.startUpdate')).toEqual([]);
});
