import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, evidencePath, navigateTo } from '../helpers/index.js';
import {
	CAPABLE_CAPABILITIES,
	LEGACY_CAPABILITIES,
	capableDetails,
	installUpdateWire,
	orchestratorState,
} from '../helpers/update-wire.js';

/**
 * Todo 41 — evidence captures of the device update surfaces, @visual.
 *
 * The PNGs are EVIDENCE written to the gitignored `test-results/`, never a
 * regression baseline: every capture is preceded by the assertion that the
 * surface is the one being photographed. The functional contract lives in
 * `update-system.spec.ts`.
 */

const UPDATES_DIALOG = 'Software Updates';

test.describe('device update surfaces @visual', () => {
	test.beforeEach(({ browserName }) => {
		test.skip(browserName !== 'chromium', 'single-browser evidence set');
	});

	test('capable-image Updates dialog with a held cellular image @visual', { tag: '@visual' }, async ({
		page,
	}, testInfo) => {
		await installUpdateWire(page, {
			orchestrator: orchestratorState('os-activation-armed'),
			fakes: {
				'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
				'system.getUpdateDetails': capableDetails(),
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-updates').click();
		const dialog = page.getByRole('dialog', { name: UPDATES_DIALOG });
		await expect(dialog.getByTestId('update-cellular-pending')).toBeVisible();
		await expect(dialog.getByTestId('updates-slots')).toBeVisible();
		await page.screenshot({
			path: evidencePath(`todo-41-updates-capable-${testInfo.project.name}.png`),
			fullPage: true,
		});
	});

	test('legacy-image Updates dialog @visual', { tag: '@visual' }, async ({ page }, testInfo) => {
		await installUpdateWire(page, {
			fakes: { 'system.getUpdateCapabilities': LEGACY_CAPABILITIES },
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-updates').click();
		const dialog = page.getByRole('dialog', { name: UPDATES_DIALOG });
		await expect(dialog.getByTestId('update-legacy-notice')).toBeVisible();
		await page.screenshot({
			path: evidencePath(`todo-41-updates-legacy-${testInfo.project.name}.png`),
			fullPage: true,
		});
	});

	test('Live cockpit with the Go-Live band and the global badge @visual', { tag: '@visual' }, async ({
		page,
	}, testInfo) => {
		const wire = await installUpdateWire(page, {
			orchestrator: orchestratorState('committing', { percent: 64, etaSeconds: 150 }),
			startable: true,
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		wire.pushStartable();
		await expect(page.getByTestId('update-refusal-band')).toBeVisible();
		await expect(page.getByTestId('update-orchestrator-badge')).toBeVisible();
		await page.screenshot({
			path: evidencePath(`todo-41-live-refusal-${testInfo.project.name}.png`),
			fullPage: true,
		});
	});
});
