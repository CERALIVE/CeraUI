/**
 * A modem change the device could not confirm, and the way out of it, @functional.
 *
 * The block is real to the page: the four recovery RPCs are answered by a journal
 * with the backend's transitions (`helpers/mutation-block-wire.ts`), everything
 * else by the live mock backend. Geometry, focus and the keyboard are what only a
 * browser can prove; the answer table lives in `NetworkView.mutationBlocks.test.ts`.
 */
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { MutationBlockDevice } from '../../src/tests/helpers/mutation-block-device';
import { runAxe } from './helpers/axe.js';
import { measureHitAreas } from './helpers/hit-area.js';
import { ensureAuthenticated, navigateTo, setLocale, setTheme } from './helpers/index.js';
import { attachMutationBlocks, DONGLE, MODEM, type MutationBlockWire } from './helpers/mutation-block-wire.js';

const notice = (page: Page, key: string): Locator =>
	page.locator(`[data-testid="mutation-block"][data-stable-key="${key}"]`);
const action = (page: Page, key: string, name: 'check' | 'keep' | 'gone'): Locator =>
	notice(page, key).getByTestId(`mutation-block-${name}`);
const outcome = (page: Page, key: string): Locator =>
	notice(page, key).getByTestId('mutation-block-outcome');
const confirmation = (page: Page): Locator => page.getByTestId('mutation-block-confirm');

async function openNetwork(page: Page): Promise<void> {
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'network');
	await expect(page.getByTestId('modem-row').first()).toBeVisible();
}

async function expectFits(page: Page): Promise<void> {
	expect(
		await page.evaluate(() => {
			const wide = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
			const clipped = [...document.querySelectorAll<HTMLElement>('[data-testid="mutation-block"] *')]
				.filter((el) => !el.closest('.sr-only') && el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).display !== 'inline')
				.map((el) => el.dataset.testid ?? el.tagName);
			return { wide, clipped };
		}),
	).toEqual({ wide: 0, clipped: [] });
	const targets = await measureHitAreas(
		page,
		'[data-testid="mutation-block"] [data-slot="button"], [data-testid="mutation-block-confirm"] button',
	);
	expect(targets.length).toBeGreaterThan(0);
	expect(targets.filter(({ hitWidth, hitHeight }) => hitWidth < 44 || hitHeight < 44)).toEqual([]);
}

test('a blocked modem says so on its own row, and the keyboard settles it', async ({ page }) => {
	const wire = await attachMutationBlocks(page);
	wire.device.set(MODEM, { kind: 'usb-mode', checkable: true });
	await openNetwork(page);

	const row = page.getByTestId('modem-row').filter({ has: notice(page, MODEM) });
	await expect(row).toHaveCount(1);
	await expect(page.getByTestId('mutation-block')).toHaveCount(1);
	await expectFits(page);

	const check = action(page, MODEM, 'check');
	await check.focus();
	await page.keyboard.press('Tab');
	await expect(action(page, MODEM, 'keep')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(action(page, MODEM, 'gone')).toBeFocused();

	const release = wire.hold();
	await check.press('Enter');
	await expect(notice(page, MODEM).getByTestId('mutation-block-working')).not.toBeEmpty();
	await expect(check).toBeFocused();
	await expect(check).toHaveAttribute('aria-disabled', 'true');
	release();

	await expect(outcome(page, MODEM)).toHaveAttribute('data-outcome', 'applied');
	await expect(check).toHaveCount(0);
	await expect(notice(page, MODEM)).toBeFocused();

	await navigateTo(page, 'settings');
	await navigateTo(page, 'network');
	await expect(page.getByTestId('modem-row').first()).toBeVisible();
	await expect(page.getByTestId('mutation-block')).toHaveCount(0);
});

test('Keep current settings asks first, Escape backs out to the button, and confirming settles it', async ({ page }) => {
	const wire = await attachMutationBlocks(page);
	wire.device.set(DONGLE, { matches: false });
	await openNetwork(page);

	const keep = action(page, DONGLE, 'keep');
	await keep.press('Enter');
	await expect(confirmation(page)).toBeVisible();
	await expectFits(page);
	expect(await confirmation(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
	await page.keyboard.press('Escape');
	await expect(confirmation(page)).toBeHidden();
	await expect(keep).toBeFocused();
	expect(wire.device.list().blocks).toHaveLength(1);

	await keep.press('Enter');
	await page.getByTestId('mutation-block-confirm-action').press('Enter');
	await expect(outcome(page, DONGLE)).toHaveAttribute('data-outcome', 'applied');
	await expect(notice(page, DONGLE)).toBeFocused();
	expect(wire.device.list().blocks).toEqual([]);
});

test('a refusal stays beside the buttons with its reason, and the buttons keep working', async ({ page }) => {
	const wire = await attachMutationBlocks(page);
	wire.device.set(DONGLE, { checkable: true, matches: false });
	await openNetwork(page);
	await action(page, DONGLE, 'check').press('Enter');
	await expect(outcome(page, DONGLE)).toHaveAttribute('data-outcome', 'refused');
	await expect(action(page, DONGLE, 'check')).toBeFocused();
	await expectFits(page);
	wire.device.set(DONGLE, { checkable: true });
	await action(page, DONGLE, 'check').press('Enter');
	await expect(outcome(page, DONGLE)).toHaveAttribute('data-outcome', 'applied');
});

test('an unplugged dongle moves to the top of the Cellular card and can be marked as gone', async ({ page }) => {
	const wire = await attachMutationBlocks(page);
	wire.device.set(DONGLE);
	await openNetwork(page);

	await action(page, DONGLE, 'gone').click();
	await expect(confirmation(page)).toBeVisible();
	const rows = await page.getByTestId('modem-row').count();
	wire.device.set(DONGLE, { present: false });
	wire.unplug(DONGLE);
	await expect(page.getByTestId('modem-row')).toHaveCount(rows - 1);
	await expect(confirmation(page)).toBeVisible();
	await page.getByTestId('mutation-block-confirm-action').press('Enter');

	await expect(outcome(page, DONGLE)).toHaveAttribute('data-outcome', 'applied');
	await expect(notice(page, DONGLE)).toBeFocused();
	expect(await notice(page, DONGLE).evaluate((el) => el.closest('[data-testid="modem-row"]'))).toBeNull();
	expect(wire.device.list().blocks.map(({ state, blocksStreaming }) => [state, blocksStreaming])).toEqual([
		['decommissioned', false],
	]);
});

test('a subnet change that cannot be confirmed leaves its notice on the row once the dialog closes', async ({ page }) => {
	const device = new MutationBlockDevice();
	const wire = await attachMutationBlocks(page, device, (path) => {
		if (path !== 'modems.setRouterSubnet') return undefined;
		device.set(DONGLE);
		return { status: 'blocked', detail: 'free text the page must not show' };
	});
	wire.dongle.router_admin = {
		admin_url: 'http://192.168.8.1',
		reachable: true,
		model: 'E3372',
		controls: { mobile_data: true, roaming_autoconnect: false },
	};
	await openNetwork(page);
	await expect(page.getByTestId('mutation-block')).toHaveCount(0);
	const row = page.locator('[data-testid="modem-row"][data-class-band="router-ethernet"]').first();
	await row.getByTestId('open-modem-config-dialog').click();
	await page.getByTestId('dongle-subnet-address').fill('192.168.9.1');
	await page.getByTestId('dongle-subnet-start').click();
	await page.getByTestId('dongle-subnet-apply').click();
	await expect(page.getByTestId('dongle-subnet-outcome')).toHaveAttribute('data-outcome', 'unknown');
	await expect(page.getByText('free text the page must not show')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(action(page, DONGLE, 'keep')).toBeVisible();
	await expect(row.filter({ has: notice(page, DONGLE) })).toHaveCount(1);
});

test('two browsers: one settles it, the other learns it from its next answer', async ({ page, context }) => {
	const wire = await attachMutationBlocks(page);
	wire.device.set(MODEM, { checkable: true });
	await openNetwork(page);
	const other = await context.newPage();
	await attachMutationBlocks(other, wire.device);
	await openNetwork(other);

	await action(other, MODEM, 'check').press('Enter');
	await expect(outcome(other, MODEM)).toHaveAttribute('data-outcome', 'applied');

	await page.bringToFront();
	await action(page, MODEM, 'check').press('Enter');
	await expect(outcome(page, MODEM)).toHaveAttribute('data-outcome', 'applied');
	await expect(action(page, MODEM, 'check')).toHaveCount(0);
	expect(wire.device.list().blocks).toEqual([]);
});

test('a dropped link holds the actions, and the reconnect re-reads the list', async ({ page }) => {
	const wire = await attachMutationBlocks(page);
	wire.device.set(MODEM);
	await openNetwork(page);
	await expect(action(page, MODEM, 'keep')).toBeVisible();
	await expect(action(page, MODEM, 'check')).toHaveCount(0);
	await wire.drop();
	await expect(notice(page, MODEM).getByTestId('mutation-block-offline')).toBeVisible();
	await expect(action(page, MODEM, 'keep')).toHaveAttribute('aria-disabled', 'true');
	wire.device.clear(MODEM);
	await expect(notice(page, MODEM)).toHaveCount(0, { timeout: 20_000 });
});

for (const [locale, theme] of [
	['de', 'dark'],
	['ar', 'light'],
	['ja', 'dark'],
] as const) {
	for (const width of [320, 390, 1280]) {
		test(`${locale} ${theme} at ${width}px: nothing overflows and every target is 44px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			const wire: MutationBlockWire = await attachMutationBlocks(page);
			wire.device.set(MODEM, { kind: 'usb-mode', checkable: true, matches: false });
			wire.device.set('e2e-port-unlisted', { state: 'device-absent-quarantine', present: false });
			await page.goto('/');
			await ensureAuthenticated(page);
			await setLocale(page, locale);
			await setTheme(page, theme);
			await page.reload();
			await navigateTo(page, 'network');
			await expect(page.getByTestId('mutation-block')).toHaveCount(2);
			await action(page, MODEM, 'check').press('Enter');
			await expect(outcome(page, MODEM)).toHaveAttribute('data-outcome', 'refused');
			await expectFits(page);
			const start = await notice(page, MODEM).evaluate((el) => {
				const row = el.closest('[data-net-row]')?.querySelector('[data-net-row-title]');
				const rtl = getComputedStyle(el).direction === 'rtl';
				const edge = (node: Element) => node.getBoundingClientRect()[rtl ? 'right' : 'left'];
				return row ? Math.abs(edge(el) - edge(row)) : Number.NaN;
			});
			expect(start).toBeLessThanOrEqual(1);
			await action(page, MODEM, 'gone').press('Enter');
			await expect(confirmation(page)).toBeVisible();
			await expectFits(page);
		});
	}
}

for (const theme of ['dark', 'light'] as const) {
	test(`${theme}: the notice, each of its answers and its confirmation pass axe`, async ({ page }) => {
		const wire = await attachMutationBlocks(page);
		wire.device.set(MODEM, { checkable: true, matches: false });
		await page.goto('/');
		await ensureAuthenticated(page);
		await setTheme(page, theme);
		await page.reload();
		await navigateTo(page, 'network');
		await action(page, MODEM, 'check').press('Enter');
		await expect(outcome(page, MODEM)).toHaveAttribute('data-outcome', 'refused');
		expect(await runAxe(page, { include: ['[data-testid="mutation-block"]'] })).toEqual([]);
		await action(page, MODEM, 'keep').press('Enter');
		await expect(confirmation(page)).toBeVisible();
		expect(await runAxe(page, { include: ['[data-testid="mutation-block-confirm"]'] })).toEqual([]);
		await page.keyboard.press('Escape');
		await expect(confirmation(page)).toBeHidden();

		const release = wire.hold();
		await action(page, MODEM, 'check').press('Enter');
		await expect(notice(page, MODEM).getByTestId('mutation-block-working')).not.toBeEmpty();
		await wire.drop();
		release();
		await expect(outcome(page, MODEM)).toHaveAttribute('data-outcome', 'unknown', { timeout: 20_000 });
		expect(await runAxe(page, { include: ['[data-testid="mutation-block"]'] })).toEqual([]);

		await expect(action(page, MODEM, 'keep')).not.toHaveAttribute('aria-disabled', 'true', { timeout: 20_000 });
		await action(page, MODEM, 'keep').press('Enter');
		await page.getByTestId('mutation-block-confirm-action').press('Enter');
		await expect(outcome(page, MODEM)).toHaveAttribute('data-outcome', 'applied');
		await expect(confirmation(page)).toBeHidden();
		expect(await runAxe(page, { include: ['[data-testid="mutation-block"]'] })).toEqual([]);
	});
}
