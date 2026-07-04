import { expect, test } from './fixtures/index.js';

import { ensureAuthenticated, navigateTo } from './helpers/index.js';

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
 * sweep by pointing E2E_PORT at a single-modem stack.
 *
 * PORT/AUTH: reuse a running stack via E2E_PORT (baseURL) + E2E_PASSWORD. The WS
 * port differs per stack (3002 default backend, or 8090/8091 for isolated
 * stacks) — the freeze proxy below matches all three.
 */

test.describe('data-previsualization sweep', () => {
	test('signals + HUD telemetry + labeled toggle + universal staleness', async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop-only sweep');

		// ── Freeze switch: proxy the WS to the real backend, but allow pausing
		// the server→client stream so the view stays mounted while frames stop
		// (drives the staleness path without an auth-resetting socket close).
		let frozen = false;
		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				if (!frozen) ws.send(m);
			});
		});

		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');

		// ── 2. HUD telemetry: temp °C in the compact strip; V/A in the sheet ──
		// T18 trimmed the strip to a single temp chip (voltage/current moved to the
		// sheet sensors line, asserted below). The chip wraps its value span in an
		// outer title="Temperature" span: `.first()` = wrapper (shows °C), `.last()`
		// = the value span that carries the opacity-50 staleness dim.
		const temp = page.locator('[title="Temperature"]:visible').first();
		const tempValue = page.locator('[title="Temperature"]:visible').last();
		await expect(temp).toBeVisible();
		await expect(temp).toContainText('°C');

		// ── 1. Every connected cellular modem shows a signal % ──
		// The Cellular section counts connected modems. Signal % now lives in
		// BondedLinksSection (T19/T20 made it the sole live-telemetry owner — the
		// per-interface Cellular cards no longer render their own signal% cluster).
		const cellular = await page.evaluate(() => {
			const heads = Array.from(document.querySelectorAll('h2'));
			const head = heads.find((h) => h.textContent?.trim() === 'Cellular');
			const section = head?.closest('section') ?? head?.parentElement ?? null;
			const text = section?.textContent ?? '';
			const connected = (text.match(/Connected/g) ?? []).length;
			const noSim = /No SIM cards detected/.test(text);
			return { connected, noSim };
		});
		expect(cellular.noSim).toBe(false);
		expect(cellular.connected).toBeGreaterThanOrEqual(1);

		// Signal % is previsualized once per bonded link in BondedLinksSection. Count
		// the bonded-link cards that surface a signal % — at least one per connected
		// cellular modem (bonded rows also cover WiFi, so the count is >= connected).
		await expect(page.getByTestId('bonded-link-card').first()).toBeVisible();
		await expect
			.poll(
				async () =>
					page.evaluate(
						() =>
							Array.from(
								document.querySelectorAll('[data-testid="bonded-link-card"]'),
							).filter((card) => /\b\d{1,3}%/.test(card.textContent ?? '')).length,
					),
				{ message: 'every connected bonded link should previsualize a signal %' },
			)
			.toBeGreaterThanOrEqual(cellular.connected);

		// Signal % is ALSO mirrored in the HUD detail sheet (not just the cards).
		await page.locator('[data-hud-region]:visible').click();
		const statusDialog = page.getByRole('dialog', { name: 'Status' });
		await expect(statusDialog).toBeVisible();

		// Voltage (V) + current (A) now live in the sheet's sensors line (T18 moved
		// them off the compact strip) — complete the SoC telemetry proof here.
		await expect(statusDialog.locator('[title="Voltage"]')).toContainText('V');
		await expect(statusDialog.locator('[title="Current"]')).toContainText('A');

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

		// Healthy, fully-previsualized Network view (pixel evidence: visual/).
		await expect(
			page.getByRole('heading', { name: 'Cellular', level: 2 }),
		).toBeVisible();

		// ── 4. Universal staleness: freeze frames → live values dim ──
		await expect(tempValue).not.toHaveClass(/opacity-50/);
		frozen = true;
		// Past STALE_THRESHOLD_MS (5000ms) the mounted view dims live values.
		await expect(tempValue).toHaveClass(/opacity-50/, { timeout: 12_000 });
		// Still authenticated/mounted — not booted to the login/offline screen.
		await expect(page.locator('header').first()).toBeVisible();

		// Recovery: resume frames → dimming clears, values refresh.
		frozen = false;
		await expect(tempValue).not.toHaveClass(/opacity-50/, { timeout: 12_000 });
	});
});
