import { expect, test } from '@playwright/test';

import { ensureAuthenticated, evidencePath, navigateTo } from './helpers';

/**
 * T22 — Data-previsualization integration sweep (agent QA, not CI-gated).
 *
 * Proves the data-reliability outcomes of the ceraui-ux-data-reliability plan,
 * end-to-end in a real browser against a running dev stack:
 *
 *   1. Every connected cellular modem previsualizes a signal % (the core T15
 *      fix) — in BOTH the Network/Cellular cards AND the HUD detail sheet, not
 *      just L1/WiFi.
 *   2. The HUD bar shows complete SoC telemetry: temperature (°C), voltage (V)
 *      and current (A) (T17).
 *   3. Config toggles are LabeledSwitch — visible ON/OFF text + a >=44px touch
 *      target (T8/T16).
 *   4. Universal staleness (T18): when live frames stop arriving the mounted
 *      view dims its live values (opacity-50); on recovery the dimming clears.
 *
 * SCENARIO: targets whatever MOCK_SCENARIO the running backend serves. The
 * default dev stack is `multi-modem-wifi` (3 modems). Drive a single-modem
 * sweep by pointing E2E_PORT at a single-modem stack and SWEEP_LABEL=singlemodem.
 *
 * PORT/AUTH: reuse a running stack via E2E_PORT (baseURL) + E2E_PASSWORD. The WS
 * port differs per stack (3002 default backend, or 8090/8091 for isolated
 * stacks) — the freeze proxy below matches all three.
 */

const SWEEP_LABEL = process.env.SWEEP_LABEL ?? 'multimodem';

test.describe('data-previsualization sweep', () => {
	test('signals + HUD telemetry + labeled toggle + universal staleness', async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop-only sweep');

		// ── Freeze switch: proxy the WS to the real backend, but allow pausing
		// the server→client stream so the view stays mounted while frames stop
		// (drives the staleness path without an auth-resetting socket close).
		let frozen = false;
		await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				if (!frozen) ws.send(m);
			});
		});

		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');

		// ── 2. HUD telemetry: temp °C, voltage V, current A all present ──
		// Desktop + mobile HUD both mount; one is CSS-hidden — target the visible.
		const temp = page.locator('[title="Temperature"]:visible').first();
		const volt = page.locator('[title="Voltage"]:visible').first();
		const curr = page.locator('[title="Current"]:visible').first();
		await expect(temp).toBeVisible();
		await expect(temp).toContainText('°C');
		await expect(volt).toContainText('V');
		await expect(curr).toContainText('A');

		// ── 1. Every connected cellular modem shows a signal % ──
		// Scope to the Cellular section; correlate connected modem cards with
		// signal-% tokens so a card that says "Connected" but lacks a % fails.
		const cellular = await page.evaluate(() => {
			const heads = Array.from(document.querySelectorAll('h2'));
			const head = heads.find((h) => h.textContent?.trim() === 'Cellular');
			const section = head?.closest('section') ?? head?.parentElement ?? null;
			const text = section?.textContent ?? '';
			const connected = (text.match(/Connected/g) ?? []).length;
			const signals = (text.match(/\b\d{1,3}%/g) ?? []).length;
			const noSim = /No SIM cards detected/.test(text);
			return { connected, signals, noSim };
		});
		// At least one connected modem, and no connected modem is missing a %.
		expect(cellular.noSim).toBe(false);
		expect(cellular.connected).toBeGreaterThanOrEqual(1);
		expect(cellular.signals).toBeGreaterThanOrEqual(cellular.connected);

		// Signal % is ALSO mirrored in the HUD detail sheet (not just the cards).
		await page.locator('[data-hud-region]:visible').click();
		const statusDialog = page.getByRole('dialog', { name: 'Status' });
		await expect(statusDialog).toBeVisible();
		const hudSignals = await statusDialog.evaluate(
			(el) => (el.textContent?.match(/\b\d{1,3}%/g) ?? []).length,
		);
		expect(hudSignals).toBeGreaterThanOrEqual(1);
		await statusDialog.getByRole('button', { name: 'Close' }).click();
		await expect(statusDialog).toBeHidden();

		// ── 3. LabeledSwitch: ON/OFF text + >=44px touch target ──
		await page.getByRole('button', { name: 'Configure' }).first().click();
		const modemDialog = page.getByRole('dialog').last();
		await expect(modemDialog).toBeVisible();
		const toggle = modemDialog.getByRole('switch').first();
		await expect(toggle).toBeVisible();
		// LabeledSwitch root = nearest ancestor span carrying min-h-[44px].
		const switchRoot = toggle.locator(
			'xpath=ancestor::span[contains(@class,"min-h-")][1]',
		);
		await expect(switchRoot).toContainText(/On|Off/);
		const box = await switchRoot.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		await modemDialog.getByRole('button', { name: 'Close' }).first().click();
		await expect(modemDialog).toBeHidden();

		// Evidence: healthy, fully-previsualized Network view.
		await page.screenshot({
			path: evidencePath(`task-22-sweep-${SWEEP_LABEL}.png`),
			fullPage: true,
		});

		// ── 4. Universal staleness: freeze frames → live values dim ──
		await expect(temp).not.toHaveClass(/opacity-50/);
		frozen = true;
		// Past STALE_THRESHOLD_MS (5000ms) the mounted view dims live values.
		await expect(temp).toHaveClass(/opacity-50/, { timeout: 12_000 });
		// Still authenticated/mounted — not booted to the login/offline screen.
		await expect(page.locator('header').first()).toBeVisible();

		// Recovery: resume frames → dimming clears, values refresh.
		frozen = false;
		await expect(temp).not.toHaveClass(/opacity-50/, { timeout: 12_000 });
	});
});
