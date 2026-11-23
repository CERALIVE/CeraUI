import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers";

test.use({ backendScenario: "wifi-limited" });

test("limited radio keeps details, Copy and Stop while refusing hotspot changes", async ({ page, backendRpc }) => {
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "network");
	const row = page.getByTestId("wifi-row").filter({ has: page.getByTestId("open-hotspot-details") });
	await expect(row).toContainText("CeraLive-Hotspot");
	await expect(row.locator('[data-reason="permanent-mac-unresolved"]')).toBeVisible();
	await expect(row.getByTestId("open-hotspot-setup")).toHaveCount(0);
	await row.getByTestId("open-hotspot-details").click();
	const dialog = page.getByRole("dialog", { name: "Configure Hotspot" });
	await expect(dialog.getByRole("button", { name: "Copy network name", exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Copy password", exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "Enable Hotspot", exact: true })).toHaveCount(0);
	await expect(dialog.getByLabel("Name", { exact: true })).toHaveAttribute("readonly", "");
	expect(await backendRpc.call(["wifi", "hotspotStart"], { device: "0" })).toEqual({
		success: false, error: "radio-unverified",
	});
	await dialog.getByRole("button", { name: "Turn Off", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "Turn Off", exact: true })).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "Enable Hotspot", exact: true })).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});
