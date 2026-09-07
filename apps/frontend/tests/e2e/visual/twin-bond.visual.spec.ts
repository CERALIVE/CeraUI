import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo } from '../helpers/index.js';
import { installTwinBondWire, TWIN_NETIF } from '../helpers/twin-bond-wire.js';

for (const width of [375, 768, 1280]) {
	test(`captured twin eligibility stays legible at ${width}px @visual`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 1000 });
		const publish = await installTwinBondWire(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
		publish(TWIN_NETIF);
		const section = page.getByRole('region', { name: 'Bonded Links', exact: true });
		await expect(section.getByTestId('bonded-link-card')).toHaveCount(2);
		for (const iface of Object.keys(TWIN_NETIF)) {
			const card = section.locator(`[data-link-id="${iface}"]`);
			await expect(card.getByTestId('bonded-link-identity')).toHaveText(iface);
			const label = card.getByText('Huawei E3372', { exact: true });
			await expect(label).toBeVisible();
			expect(await label.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(100);
		}
		expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
		await section.screenshot({ path: testInfo.outputPath(`twins-${width}.png`) });
		await testInfo.attach('bonded-links-dom', { body: await section.ariaSnapshot(), contentType: 'text/plain' });
	});
}
