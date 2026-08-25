import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import {
	degradedUplinks,
	FLOWS_RESET_IFNAME,
	healthyThreeUplinks,
	installSharingWire,
	type SharingWire,
	SHARED_LAN_IFNAME,
	steeringUnavailable,
} from './helpers/sharing-wire.js';

/**
 * The Internet-Sharing surface, in a real browser, over injected fixtures.
 *
 * The three uplink signals it reads are `isRealDevice()`-gated, so a dev/CI
 * worker publishes none of them — see `helpers/sharing-wire.ts` for why that
 * silence is the seam rather than a gap, and for what this does and does not
 * prove. Every assertion below is structural or textual; none is a screenshot
 * (PLAYBOOK.md), and the baselines live in `visual/sharing.visual.spec.ts`.
 */

const CARD = '[data-testid="sharing-section"]';

test.describe('Internet-Sharing surface', () => {
	let wire: SharingWire;

	test.beforeEach(async ({ page }) => {
		wire = await installSharingWire(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
		await wire.publish();
		await expect(page.locator(CARD)).toBeVisible();
	});

	test('healthy 3-uplink: a row each, weights, and the captive portal named in words', async ({
		page,
	}) => {
		await wire.set(healthyThreeUplinks());

		for (const iface of ['wwan0', 'wwan1', 'wlan0']) {
			await expect(page.getByTestId(`sharing-uplink-${iface}`)).toBeVisible();
		}

		await expect(page.getByTestId('sharing-uplink-wwan0')).toHaveAttribute(
			'data-state',
			'up',
		);
		await expect(page.getByTestId('sharing-uplink-weight-wwan0')).toHaveAttribute(
			'data-weight',
			'100',
		);

		// The portal is a PER-UPLINK reason on the row it belongs to, never a
		// global band, and it reaches the operator as a sentence.
		const wifiRow = page.getByTestId('sharing-uplink-wlan0');
		await expect(wifiRow).toHaveAttribute('data-state', 'degraded');
		await expect(wifiRow).toHaveAttribute('data-reason', 'captive_portal');
		await expect(page.getByTestId('sharing-uplink-reason-wlan0')).toContainText(
			'sign-in portal',
		);

		// A degraded-but-usable bond raises no reachability band.
		await expect(
			page.getByTestId('sharing-band-no-healthy-uplink'),
		).toHaveCount(0);
		await expect(page.getByTestId('sharing-priority')).toHaveAttribute(
			'data-priority',
			'adaptive-cap',
		);

		// The declared client zone is what makes the reachability bands reachable
		// at all, so its presence is asserted rather than assumed.
		await expect(
			page.getByTestId(`sharing-zone-shared-lan-${SHARED_LAN_IFNAME}`),
		).toHaveAttribute('data-zone', 'serving');
		await expect(page.getByTestId('sharing-band-sharing-off')).toHaveCount(0);
	});

	test('degraded: the no-healthy-uplink band, a visibly stale row, and honest priority', async ({
		page,
	}) => {
		await wire.set(degradedUplinks());

		const band = page.getByTestId('sharing-band-no-healthy-uplink');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('data-tone', 'warning');

		// The stale row still renders its last reading — dimmed and marked, never
		// blanked and never fresh-looking.
		const staleRow = page.getByTestId('sharing-uplink-wwan0');
		await expect(staleRow).toHaveAttribute('data-stale', 'true');
		await expect(
			page.locator('[data-stale-interface="wwan0"]'),
		).toBeVisible();
		await expect(page.getByTestId('sharing-uplink-eth0')).toHaveAttribute(
			'data-stale',
			'false',
		);

		const priority = page.getByTestId('sharing-priority');
		await expect(priority).toHaveAttribute('data-priority', 'degraded');
		await expect(priority).toHaveAttribute('data-reason', 'foreign_qdisc');
		await expect(page.getByTestId('sharing-priority-reason')).toContainText(
			'traffic-shaping policy',
		);
	});

	test('steering-unavailable: banded with its reason, and the uplinks still listed', async ({
		page,
	}) => {
		await wire.set(steeringUnavailable());

		const band = page.getByTestId('sharing-band-steering-unavailable');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('data-reason', 'ruleset_publish_failed');
		await expect(
			page.getByTestId('sharing-band-reason-steering-unavailable'),
		).toContainText('publish');

		// It says client STEERING is off, not that the links are gone.
		await expect(page.getByTestId('sharing-uplink-wwan0')).toBeVisible();
		await expect(
			page.getByTestId('sharing-band-no-healthy-uplink'),
		).toHaveCount(0);
	});

	test('the surface never renders a raw wire token or a dotted i18n key', async ({
		page,
	}) => {
		await wire.set(steeringUnavailable());
		const text = (await page.locator(CARD).innerText()).toLowerCase();

		for (const token of [
			'ruleset_publish_failed',
			'captive_portal',
			'shaper_unavailable',
			'network.sharing.',
		]) {
			expect(text).not.toContain(token);
		}
	});

	test('the known DNS limitation is stated, whatever the wire reports', async ({
		page,
	}) => {
		for (const fixture of [
			healthyThreeUplinks(),
			degradedUplinks(),
			steeringUnavailable(),
		]) {
			await wire.set(fixture);
			await expect(page.getByTestId('sharing-dns-note')).toContainText(
				'default route',
			);
		}
	});

	test('a hard-down raises a transient notice that NAMES the interface', async ({
		page,
	}) => {
		// An interface NO fixture lists, so a match can only be the notice itself.
		await wire.flowsReset(FLOWS_RESET_IFNAME, 'lnk_9f3c11a0b2d47e58');

		await expect(
			page.getByText(new RegExp(FLOWS_RESET_IFNAME)).first(),
		).toBeVisible();
		// It is a toast, not a band: the section itself gains nothing that lingers.
		await expect(
			page.locator(CARD).getByText(new RegExp(FLOWS_RESET_IFNAME)),
		).toHaveCount(0);
	});

	test('zero healthy uplinks bands honestly and GATES NOTHING on its siblings', async ({
		page,
	}) => {
		// The MUST-NOT this whole surface is built around: every signal it reads is
		// diagnostic, so the worst reading it can render must leave the rest of the
		// Network destination exactly as it was.
		// The sibling sections are located by their own h2, the shape
		// `network-density.visual.spec.ts` already proves resolves them.
		const sibling = (name: string) =>
			page
				.getByRole('heading', { name, level: 2 })
				.locator('xpath=ancestor::section[1]');
		const names = ['Bonded Links', 'WiFi', 'Cellular', 'Ethernet'];
		const before = await Promise.all(
			names.map((name) => sibling(name).locator('button:not([disabled])').count()),
		);
		expect(before.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

		await wire.set(degradedUplinks());
		await expect(page.getByTestId('sharing-band-no-healthy-uplink')).toBeVisible();

		for (const [index, name] of names.entries()) {
			await expect(sibling(name)).toBeVisible();
			await expect(sibling(name).locator('button:not([disabled])')).toHaveCount(
				before[index] as number,
			);
		}

		await expect(page.locator(`${CARD} button`)).toHaveCount(0);
	});

	test('carries ZERO controls — every signal it renders is diagnostic only', async ({
		page,
	}) => {
		await wire.set(degradedUplinks());
		const card = page.locator(CARD);

		for (const selector of ['button', 'input', 'select', 'a[href]', '[role="switch"]']) {
			await expect(card.locator(selector)).toHaveCount(0);
		}
		// Non-vacuity: the card really did render its degraded content.
		await expect(page.getByTestId('sharing-band-no-healthy-uplink')).toBeVisible();
	});
});
