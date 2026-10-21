import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, evidencePath, navigateTo, setTheme } from '../helpers/index.js';
import { CAPABLE_CAPABILITIES, capableDetails, installUpdateWire, orchestratorState } from '../helpers/update-wire.js';

for (const theme of ['light', 'dark'] as const) {
	for (const width of [390, 1440] as const) {
		test.describe(`package route ${theme} ${width}`, () => {
			test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1 });
			test('existing package, refusal and progress surfaces @visual', async ({ page }) => {
				// Given the same capable package offer in each existing theme and density.
				const wire = await installUpdateWire(page, { orchestrator: orchestratorState('available'), packages: { kind: 'available', identity: { version: 'pkg', packages: ['cerastream'] }, package_count: 1, actionable_count: 1 }, fakes: {
					'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
					'system.getUpdateDetails': capableDetails(),
					'system.installUpdatesNow': { success: false, error: 'not_available' },
				} });
				await page.goto('/');
				await ensureAuthenticated(page);
				await setTheme(page, theme);
				await page.reload();
				await ensureAuthenticated(page);
				await navigateTo(page, 'settings');
				await page.getByTestId('settings-entry-updates').click();
				await expect(page.getByTestId('update-install')).toBeVisible();
				await page.screenshot({ path: evidencePath(`packages-${theme}-${width}-available.png`), scale: 'css' });
				// When the scoped server refuses, then the unchanged refusal primitives render.
				await page.getByTestId('update-install').click();
				await page.getByRole('dialog', { name: 'Are you absolutely sure?' }).getByRole('button', { name: 'Update', exact: true }).click();
				await expect(page.getByTestId('update-action-refused')).toBeVisible();
				await page.screenshot({ path: evidencePath(`packages-${theme}-${width}-refused.png`), scale: 'css' });
				wire.fake('system.installUpdatesNow', { success: true });
				await page.getByTestId('update-install').click();
				await page.getByRole('dialog', { name: 'Are you absolutely sure?' }).getByRole('button', { name: 'Update', exact: true }).click();
				wire.setOrchestrator(orchestratorState('downloading', { percent: 42, etaSeconds: 90 }));
				await expect(page.getByTestId('update-activity')).toHaveAttribute('data-phase', 'downloading');
				await page.getByTestId('update-activity').scrollIntoViewIfNeeded();
				await page.screenshot({ path: evidencePath(`packages-${theme}-${width}-progress.png`), scale: 'css' });
			});
		});
	}
}
