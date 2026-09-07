import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";
import { installTwinBondWire, TWIN_NETIF } from "./helpers/twin-bond-wire.js";

test("captured eligible twins render independently; backend refusal withdraws only its row", async ({ page }) => {
	const publish = await installTwinBondWire(page);
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "network");
	publish(TWIN_NETIF);
	const cards = page.getByTestId("bonded-link-card");
	await expect(cards).toHaveCount(2);
	for (const iface of Object.keys(TWIN_NETIF)) {
		const card = cards.filter({ has: page.locator(`[data-testid="bonded-link-identity"]`, { hasText: iface }) });
		await expect(card).toHaveCount(1);
		await expect(card).toHaveAttribute("data-link-id", iface);
		await expect(card.getByTestId("bonded-link-identity")).toHaveText(iface);
		await expect(card).toContainText("Huawei E3372");
	}
	await expect(page.getByTestId("bonded-links-not-bonded")).toHaveCount(0);

	const twin = TWIN_NETIF.eth1;
	if (!twin) throw new Error("captured twin missing");
	publish({ ...TWIN_NETIF, eth1: { ...twin, enabled: false } });
	await expect(cards).toHaveCount(1);
	await expect(cards).toHaveAttribute("data-link-id", "enx0c5b8f279a64");
	await expect(page.getByTestId("bonded-links-not-bonded")).toHaveAttribute("data-not-bonded-count", "1");
});

test("another error remains excluded even with enabled:true", async ({ page }) => {
	const publish = await installTwinBondWire(page);
	const twin = TWIN_NETIF.eth1;
	if (!twin) throw new Error("captured twin missing");
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "network");
	publish({ ...TWIN_NETIF, eth1: { ...twin, error: "no SIM" } });
	await expect(page.getByTestId("bonded-link-card")).toHaveCount(1);
	await expect(page.getByTestId("bonded-link-card")).toHaveAttribute("data-link-id", "enx0c5b8f279a64");
	await expect(page.getByTestId("bonded-links-not-bonded")).toHaveAttribute("data-not-bonded-count", "1");
});
