import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { closeDialog, openDialog } from './helpers/aria.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * sources-visibility.spec.ts — the "Show test pattern" Sources toggle round-trip.
 *
 * Proves the Todo-6/7/8 sources_visibility feature end-to-end against the REAL
 * per-worker backend (MOCK_SCENARIO=multi-modem-wifi natively advertises the
 * virtual test-pattern source id `test` — no WS injection needed, unlike the
 * network-ingest rows which the default backend does not advertise):
 *
 *   (a) baseline           — the Live picker shows the test-pattern row.
 *   (b) hide (unselected)   — Settings → Sources → toggle "Show test pattern"
 *                             OFF → confirming `config` broadcast → the Live
 *                             source list no longer shows the row.
 *   (c) hide (selected)     — select the test pattern FIRST, then hide it → the
 *                             row STAYS visible, disabled, with the reason +
 *                             Settings-hint copy (fail-visible).
 *   (d) re-enable           — toggle back ON → the row is selectable again.
 *   (e) RPC failure         — with `streaming.setSourceVisibility` forced to fail
 *                             over the socket, the toggle stays put and the calm
 *                             inline failure band renders (no toast — silent op).
 *
 * The switch is pessimistic ("Show test pattern": CHECKED = visible): its
 * position moves only once the confirming broadcast lands, so `toBeChecked()` /
 * `not.toBeChecked()` is the confirming-broadcast wait. Each test normalizes the
 * toggle to a known state first, so the file is order- and retry-independent.
 *
 * PLAYBOOK.md compliance: openDialog/closeDialog aria helpers + navigateTo,
 * role/testid/web-first assertions only — no screenshots, no fixed-delay waits.
 */

const DIALOG_NAME = 'Sources';
// The `network.os.operationFailed` copy the silent-op failure band renders.
const FAILURE_BAND_COPY = "Couldn't complete the action";
// Any enabled non-virtual source select (multi-modem-wifi advertises hdmi /
// libuvch264 coarse rows) — used to deselect the test pattern without hardcoding
// a concrete id.
const ALT_SOURCE_SELECT =
	'button[data-testid^="source-select-"]:not([data-testid="source-select-test"])';

/** Open the Settings → Sources dialog via its entry button; return the toggle. */
async function openSourcesDialog(page: Page) {
	await navigateTo(page, 'settings');
	const trigger = page.getByRole('button', { name: /^Sources/ }).first();
	await openDialog(page, trigger, DIALOG_NAME);
	return page.getByTestId('sources-test-pattern-toggle');
}

/**
 * Drive the "Show test pattern" toggle to `show`, waiting for the confirming
 * `config` broadcast (the switch is pessimistic). Idempotent — a no-op when it
 * already reflects `show`.
 */
async function setTestPatternShown(page: Page, show: boolean): Promise<void> {
	const toggle = await openSourcesDialog(page);
	const isShown = await toggle.isChecked();
	if (isShown !== show) {
		await toggle.click();
		if (show) await expect(toggle).toBeChecked();
		else await expect(toggle).not.toBeChecked();
	}
	await closeDialog(page, DIALOG_NAME);
}

test.describe('Source visibility — test pattern hide/show', () => {
	test.beforeEach(({ browserName: _b }, testInfo) => {
		test.skip(
			testInfo.project.name !== 'desktop',
			'desktop layout drives the source surface; mobile is the @visual suite',
		);
	});

	test('hides the test-pattern row from the Live picker when disabled, restores it when re-enabled', async ({
		authedPage: page,
	}) => {
		// Normalize: shown + NOT selected, so the unselected-hide filter is exercised.
		await setTestPatternShown(page, true);
		await navigateTo(page, 'live');
		const testRow = page.getByTestId('source-row-test');
		await expect(testRow).toBeVisible({ timeout: 15_000 });
		if ((await testRow.getAttribute('data-selected')) === 'true') {
			await page.locator(ALT_SOURCE_SELECT).first().click();
			await expect(testRow).toHaveAttribute('data-selected', 'false');
		}

		// (a) baseline — the test-pattern row is in the Live picker.
		await expect(testRow).toBeVisible();
		await expect(page.getByTestId('source-select-test')).toBeEnabled();

		// (b) hide it in Settings → the confirming broadcast removes the Live row.
		await setTestPatternShown(page, false);
		await navigateTo(page, 'live');
		await expect(page.getByTestId('source-row-test')).toHaveCount(0);
		await expect(page.getByTestId('source-select-test')).toHaveCount(0);
		// A non-virtual source is unaffected — the filter is scoped to the hidden row.
		await expect(page.locator(ALT_SOURCE_SELECT).first()).toBeVisible();

		// (d) re-enable → the row returns, selectable.
		await setTestPatternShown(page, true);
		await navigateTo(page, 'live');
		await expect(page.getByTestId('source-row-test')).toBeVisible();
		await expect(page.getByTestId('source-select-test')).toBeEnabled();
	});

	test('keeps a SELECTED test-pattern row visible, disabled, with the Settings hint when hidden', async ({
		authedPage: page,
	}) => {
		// Normalize shown, then SELECT the test pattern as the active source.
		await setTestPatternShown(page, true);
		await navigateTo(page, 'live');
		await expect(page.getByTestId('source-select-test')).toBeVisible({ timeout: 15_000 });
		await page.getByTestId('source-select-test').click();
		await expect(page.getByTestId('source-row-test')).toHaveAttribute('data-selected', 'true');

		// (c) hide it → because it IS the selected source it stays VISIBLE, disabled,
		// with the reason line AND the Settings-hint line (fail-visible).
		await setTestPatternShown(page, false);
		await navigateTo(page, 'live');
		await expect(page.getByTestId('source-row-test')).toBeVisible();
		await expect(page.getByTestId('source-select-test')).toBeDisabled();
		await expect(page.getByTestId('source-hidden-reason-test')).toBeVisible();
		await expect(page.getByTestId('source-hidden-settings-hint-test')).toBeVisible();

		// (d) re-enable → the selected row is selectable again.
		await setTestPatternShown(page, true);
		await navigateTo(page, 'live');
		await expect(page.getByTestId('source-select-test')).toBeEnabled();

		// Cleanup: move the selection off the test pattern so a same-worker rerun of
		// the unselected-hide test starts from a non-test source.
		await page.locator(ALT_SOURCE_SELECT).first().click();
		await expect(page.getByTestId('source-row-test')).toHaveAttribute('data-selected', 'false');
	});

	test('a failed setSourceVisibility keeps the toggle put and shows the calm failure band', async ({
		page,
	}) => {
		// Force every streaming.setSourceVisibility RPC to resolve as a business
		// failure (backend returns {success:false}); forward every other frame so the
		// app boots against the real backend. Registered BEFORE the page loads.
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => {
				const text = typeof m === 'string' ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { id?: string | number; path?: unknown };
					const rpcPath = Array.isArray(frame.path) ? frame.path.join('.') : null;
					if (rpcPath === 'streaming.setSourceVisibility' && frame.id !== undefined) {
						ws.send(
							JSON.stringify({
								id: frame.id,
								result: { success: false, error: 'e2e_forced_failure' },
							}),
						);
						return;
					}
				} catch {
					/* non-RPC / binary frame */
				}
				server.send(m);
			});
			server.onMessage((m) => ws.send(m));
		});

		await page.goto('/');
		await ensureAuthenticated(page);

		const toggle = await openSourcesDialog(page);
		await expect(toggle).toBeVisible();
		const before = await toggle.getAttribute('aria-checked');

		// Attempt the toggle → the RPC fails → the calm inline band renders (silent
		// op, no toast) and the switch stays in its prior position (pessimistic).
		await toggle.click();
		const band = page.getByTestId('sources-test-pattern-error');
		await expect(band).toBeVisible();
		await expect(band).toHaveText(FAILURE_BAND_COPY);
		await expect(toggle).toHaveAttribute('aria-checked', before ?? 'true');
	});
});
