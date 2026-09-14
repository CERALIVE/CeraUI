import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

test("Device Health hydrates at login without waiting for periodic telemetry", async ({
	page,
}) => {
	await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const frame: unknown = JSON.parse(String(message));
			// Periodic broadcasts carry seq; targeted login snapshots do not.
			// Suppress only the former so a later tick cannot rescue missing hydration.
			if (
				typeof frame === "object" && frame !== null &&
				"device-stats" in frame && "seq" in frame
			) return;
			ws.send(message);
		});
	});

	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "settings");
	await page.getByRole("button", { name: /Device Health/i }).first().click();

	const panel = page.getByTestId("device-health");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("health-load-gpu-value")).toHaveText("61%");
	await expect(panel.getByTestId("health-load-ddr-value")).toHaveText("37%");
});
