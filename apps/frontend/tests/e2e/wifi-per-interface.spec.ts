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
 *   (c) every hotspot-capable station row carries its own Hotspot mode rung.
 *       Todo 14 replaced the icon-only "Switch to Hotspot" trigger with ONE
 *       Station/Hotspot/Hybrid selector (`WifiModeSelector.svelte`), so the
 *       trigger is now a `role="radio"` rung whose accessible name IS the mode's
 *       own word — the deliberate inversion of the old icon-only rule, because
 *       the shared mode vocabulary is the point. It still keeps the 44px
 *       touch-target sizing token. Same guarantee as before (one per radio, each
 *       bound to its own device), restated against the control that replaced it.
 *
 *       WHERE that rung lives moved again in todo 32 (`cc23830`): the selector is
 *       no longer under the row, it is behind the row's own "Mode" affordance
 *       (`open-wifi-mode`, one per radio) in a bits-ui popover — which renders
 *       NOTHING while closed and is PORTALLED to `<body>` while open. So the
 *       guarantee is now proven per row rather than by one section-wide count:
 *       the section is asked for the affordances (which ARE in the row, one per
 *       radio), and each one's popover is asked for its single Hotspot rung. A
 *       section-scoped `getByRole('radio')` cannot see a portalled rung at all,
 *       which is exactly how this read 0 after that move.
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

	test('the Switch to Hotspot trigger is a Hotspot mode rung carrying its own word', async ({
		authedPage: page,
	}) => {
		await navigateTo(page, 'network');

		const section = wifiSection(page);

		// (c) One "Mode" affordance per station row, each bound to its OWN radio
		// via a distinct, non-empty data-device — the per-row guarantee, now
		// carried by the control that reveals the rungs.
		const modeTriggers = section.getByTestId('open-wifi-mode');
		await expect(modeTriggers).toHaveCount(STATION_RADIO_COUNT);

		const devices = await modeTriggers.evaluateAll((els) =>
			els.map((el) => el.getAttribute('data-device')),
		);
		expect(devices.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
		expect(new Set(devices).size).toBe(devices.length);

		// At rest the rungs are not merely unopened — a closed bits-ui popover
		// renders no content at all, so nothing anywhere on the page claims a mode
		// the operator has not asked to see.
		await expect(page.getByRole('radio', { name: 'Hotspot', exact: true })).toHaveCount(0);

		const testIds: string[] = [];

		for (const device of devices) {
			await section
				.locator(`[data-testid="open-wifi-mode"][data-device="${device}"]`)
				.click();

			// The popover is portalled to <body>, so it is reached from the page.
			const popover = page.getByTestId(`wifi-mode-popover-${device}`);
			await expect(popover).toBeVisible();

			// Exactly ONE hotspot rung behind this radio's affordance, exposing its
			// accessible name through the mode's own word (getByRole matches it) …
			const hotspotRung = popover.getByRole('radio', { name: 'Hotspot', exact: true });
			await expect(hotspotRung).toHaveCount(1);
			await expect(hotspotRung).toBeVisible();

			// … rendering the VISIBLE word rather than an icon alone (Todo 14's
			// deliberate inversion — a mode rung's whole job is to carry its word) …
			await expect(hotspotRung).toHaveText('Hotspot');

			// … and keeping the 44px touch-target sizing token.
			await expect(hotspotRung).toHaveClass(/min-h-\[var\(--touch-target-min\)\]/);

			testIds.push((await hotspotRung.getAttribute('data-testid')) ?? '');

			// Close before opening the next radio's popover — one at a time, so a
			// rung can never be attributed to the wrong row.
			await page.keyboard.press('Escape');
			await expect(popover).toBeHidden();
		}

		// One rung per radio, each bound to its OWN device (distinct testids).
		expect(testIds).toHaveLength(STATION_RADIO_COUNT);
		expect(testIds.every((id) => id.length > 0)).toBe(true);
		expect(new Set(testIds).size).toBe(testIds.length);
	});
});
