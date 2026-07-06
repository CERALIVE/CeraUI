/**
 * wifi-per-interface.spec.ts — per-interface WiFi Connect + icon-only hotspot trigger.
 *
 * Proves the Todo-1/Todo-2 WifiSection redesign at the rendered-DOM level:
 *   (a) every station-mode radio row carries its OWN Connect button
 *       (`data-testid="open-wifi-selector-dialog"`, one per station row, each
 *       bound to its own radio via a distinct `data-device`) and the section
 *       header carries NONE (the former header-level Connect is gone);
 *   (b) clicking a row's Connect opens the WiFi selector scoped to THAT radio's
 *       device (dialog visible + scanned network list renders);
 *   (c) the "Switch to Hotspot" trigger is icon-only — it exposes its accessible
 *       name via aria-label (getByRole button name) and renders no visible text.
 *
 * Functional spec (NO screenshots — see PLAYBOOK.md). Default worker scenario is
 * `multi-modem-wifi`, which seeds two station radios (both hotspot-capable) — a
 * deterministic two-row WiFi section. The single-modem (no-WiFi) negative control
 * lives in a SIBLING file (`wifi-per-interface-empty.spec.ts`) because
 * `backendScenario` is a worker-scoped option and a file hosts exactly one
 * scenario (PLAYBOOK).
 */
import { expect, type Page, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

// The deterministic multi-modem-wifi fixture seeds exactly two station radios
// (apps/backend/src/mocks/mock-config.ts `mockWifiRadios`). The DOM `data-device`
// key is a runtime WifiInterfaceId, not the ifname, so it is read from the DOM
// rather than hardcoded.
const STATION_RADIO_COUNT = 2;

/** The WiFi <section> located by its level-2 heading. */
function wifiSection(page: Page) {
	return page
		.getByRole('heading', { name: 'WiFi', level: 2 })
		.locator('xpath=ancestor::section[1]');
}

test.describe('Per-interface WiFi connect', () => {
	test('every station row has its own Connect button; the header has none', async ({
		authedPage: page,
	}) => {
		await navigateTo(page, 'network');

		const section = wifiSection(page);
		await expect(section).toBeVisible();

		const connectButtons = section.getByTestId('open-wifi-selector-dialog');

		// (a) one Connect per station row — count matches the seeded station radios.
		await expect(connectButtons).toHaveCount(STATION_RADIO_COUNT);

		// Each button is bound to its OWN radio via a distinct, non-empty
		// data-device (proves per-row, not a single shared trigger).
		const devices = await connectButtons.evaluateAll((els) =>
			els.map((el) => el.getAttribute('data-device')),
		);
		expect(devices.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
		expect(new Set(devices).size).toBe(devices.length);

		// The section HEADER (the div wrapping the WiFi heading) contains NO
		// Connect button — the former header-level Connect was removed.
		const header = page
			.getByRole('heading', { name: 'WiFi', level: 2 })
			.locator('xpath=parent::div');
		await expect(header.getByTestId('open-wifi-selector-dialog')).toHaveCount(0);
	});

	test("a row's Connect opens the WiFi selector scoped to that radio", async ({
		authedPage: page,
	}) => {
		await navigateTo(page, 'network');

		const section = wifiSection(page);
		const connectButtons = section.getByTestId('open-wifi-selector-dialog');
		await expect(connectButtons).toHaveCount(STATION_RADIO_COUNT);

		const dialog = page.getByRole('dialog', { name: 'Available Networks' });

		// (b) Each radio's own Connect opens the selector; a scanned network row
		// (`<p title={ssid}>`) proves the device-scoped list renders.
		for (let i = 0; i < STATION_RADIO_COUNT; i++) {
			await connectButtons.nth(i).click();
			await expect(dialog).toBeVisible();
			await expect(dialog.locator('p[title]').first()).toBeVisible({ timeout: 15_000 });

			// Close before opening the next radio's selector.
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
		}
	});

	test('the Switch to Hotspot trigger is icon-only (accessible name via aria-label)', async ({
		authedPage: page,
	}) => {
		await navigateTo(page, 'network');

		const section = wifiSection(page);

		// (c) One hotspot trigger per hotspot-capable station row, each exposing
		// its accessible name through aria-label (getByRole matches it) …
		const hotspotTriggers = section.getByRole('button', { name: 'Switch to Hotspot' });
		await expect(hotspotTriggers).toHaveCount(STATION_RADIO_COUNT);

		const first = hotspotTriggers.first();
		await expect(first).toBeVisible();

		// … and rendering NO visible text (icon-only).
		await expect(first).toHaveText('');
	});
});
