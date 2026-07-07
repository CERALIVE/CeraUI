/**
 * wifi-per-interface-empty.spec.ts — no-WiFi negative control for the
 * per-interface WiFi redesign (companion to wifi-per-interface.spec.ts).
 *
 * `backendScenario` is a WORKER-scoped option, so a file hosts exactly ONE
 * scenario and the override MUST live at file top level (PLAYBOOK.md → Per-Worker
 * Backend Scenario Override). The happy-path assertions therefore run on the
 * default `multi-modem-wifi` worker in the sibling file; THIS file pins the
 * `single-modem` worker (no WiFi radio) to prove the empty state.
 *
 * With no radios the WiFi section renders the `noWifi` empty state and ZERO
 * Connect buttons exist anywhere — the strongest proof that Connect is a
 * per-row affordance (no radios ⇒ no Connect) rather than a static header control.
 */
import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

// MUST be top-level — a worker-scoped option applies to the whole file and
// CANNOT sit inside a describe block.
test.use({ backendScenario: 'single-modem' });

test('single-modem: no WiFi radios → empty state, zero Connect buttons', async ({
	authedPage: page,
}) => {
	await navigateTo(page, 'network');

	const section = page
		.getByRole('heading', { name: 'WiFi', level: 2 })
		.locator('xpath=ancestor::section[1]');
	await expect(section).toBeVisible();

	// The calm empty state renders instead of any radio rows.
	await expect(section.getByText('No WiFi interfaces found')).toBeVisible();

	// No radios ⇒ no per-row Connect trigger anywhere on the page.
	await expect(page.getByTestId('open-wifi-selector-dialog')).toHaveCount(0);

	// …and no hotspot trigger either.
	await expect(page.getByRole('button', { name: 'Switch to Hotspot' })).toHaveCount(0);
});
