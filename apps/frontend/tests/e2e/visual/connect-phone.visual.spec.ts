import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "../helpers/index.js";

/**
 * @visual evidence + functional proof for the connect-your-phone section in
 * HotspotDialog (#67 Phase-0).
 *
 * The section calls `wifi.hotspotInfo` and renders the on-device URL + a
 * device-access QR alongside the existing WiFi-join QR. srtla/nmcli never run a
 * real hotspot under the mock, so a WebSocket proxy makes both data sources
 * deterministic:
 *   - the `wifi.hotspotInfo` RPC is answered locally (active vs off, by flag);
 *   - server `status` frames get a `hotspot` injected into the WiFi map so the
 *     existing WiFi-join QR (live credentials) renders in the active case.
 *
 * PNGs land in CeraUI/test-results/ (repo-local, gitignored). Tagged @visual so
 * the screenshot guard in fixtures permits the dialog screenshots here.
 */

const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../../test-results",
);

const ACTIVE_INFO = {
	ssid: "CeraLive-Hotspot",
	gatewayIp: "10.42.0.1",
	isActive: true,
};
const OFF_INFO = { ssid: "", gatewayIp: "", isActive: false };
const WIFI_PASSWORD = "ceralive123";

type HotspotMode = "active" | "off";

/** Add a live hotspot to the first WiFi interface so the WiFi-join QR renders. */
function injectHotspot(wifi: Record<string, Record<string, unknown>>): void {
	const firstKey = Object.keys(wifi)[0];
	if (!firstKey) return;
	const iface = wifi[firstKey];
	if (!iface) return;
	iface.supports_hotspot = true;
	iface.mode = "hotspot";
	iface.hotspot = {
		conn: "hotspot-e2e",
		name: ACTIVE_INFO.ssid,
		password: WIFI_PASSWORD,
		channel: "auto",
		available_channels: {},
	};
}

/** Open the hotspot dialog locale-agnostically (title is translated under ar). */
async function openHotspotDialog(page: Page): Promise<void> {
	await page.getByTestId("open-hotspot-dialog").click();
	await expect(page.getByRole("dialog")).toBeVisible();
}

async function closeDialog(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
}

test.describe("@visual connect-your-phone section (#67)", () => {
	// Mutable across the WS proxy closure; tests flip it before (re)opening.
	let hotspotMode: HotspotMode = "active";

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop viewport owns the evidence",
		);
		hotspotMode = "active";

		await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();

			// client -> server: answer hotspotInfo locally; forward everything else.
			ws.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const msg = JSON.parse(text) as { id?: string; path?: string[] };
					if (Array.isArray(msg.path) && msg.path.join(".") === "wifi.hotspotInfo") {
						ws.send(
							JSON.stringify({
								id: msg.id,
								result: hotspotMode === "active" ? ACTIVE_INFO : OFF_INFO,
							}),
						);
						return;
					}
				} catch {
					/* non-JSON / binary frame */
				}
				server.send(m);
			});

			// server -> client: inject a live hotspot into status.wifi when active.
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as {
						status?: { wifi?: Record<string, Record<string, unknown>> };
					};
					if (frame?.status?.wifi && hotspotMode === "active") {
						injectHotspot(frame.status.wifi);
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test("active: device URL + device QR render beside the WiFi-join QR", async ({
		page,
	}) => {
		await openHotspotDialog(page);
		const dialog = page.getByRole("dialog");
		const section = dialog.getByTestId("connect-phone-section");

		// Device URL is the bare reverse-proxy origin (no dev port literal).
		const url = section.getByTestId("device-access-url");
		await expect(url).toBeVisible();
		await expect(url).toHaveText("http://10.42.0.1/");

		// Device-access QR + the existing WiFi-join QR both present.
		await expect(section.getByTestId("device-access-qr")).toBeVisible();
		await expect(dialog.getByRole("img", { name: "WiFi QR code" })).toBeVisible();

		// Captive-portal is out: the manual-navigation note is shown.
		await expect(section.getByTestId("navigate-manually-note")).toBeVisible();

		// G3: this section never renders the password (no field, no leaked text).
		await expect(section.locator('input[type="password"]')).toHaveCount(0);
		await expect(section).not.toContainText(WIFI_PASSWORD);

		await page.screenshot({
			path: path.join(EVIDENCE_DIR, "67-connect-section.png"),
		});
	});

	test("off + RTL: URL stays dir=ltr; off prompt replaces a broken QR", async ({
		page,
	}) => {
		await setLocale(page, "ar");
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "network");

		// Active under ar: the URL element must stay left-to-right.
		await openHotspotDialog(page);
		const url = page.getByRole("dialog").getByTestId("device-access-url");
		await expect(url).toBeVisible();
		await expect(url).toHaveAttribute("dir", "ltr");
		await closeDialog(page);

		// Off: the off-prompt replaces the device QR (no broken image).
		hotspotMode = "off";
		await openHotspotDialog(page);
		const section = page.getByRole("dialog").getByTestId("connect-phone-section");
		await expect(section.getByTestId("hotspot-off-prompt")).toBeVisible();
		await expect(section.getByTestId("device-access-qr")).toHaveCount(0);

		await page.screenshot({
			path: path.join(EVIDENCE_DIR, "67-off-rtl.png"),
		});
	});
});
