import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the per-adapter Wi-Fi capability strip.
 *
 * The PNGs are the artifact; every criterion is ASSERTED, so a reviewer is never
 * asked to eyeball whether the right bands were offered. Two facts are proven
 * here that a jsdom unit test structurally cannot:
 *
 *   • the strip is REACHABLE on the real Network destination, rendered by the
 *     shipped `getWifi()` wiring rather than by props handed to the component;
 *   • the reason band's "Set country" really does reach `WifiCountryDialog` —
 *     the dialog is lazily imported by `NetworkView`, so nothing but a live
 *     browser can show that the chunk resolves and the dialog opens.
 *
 * State is injected through the dev-only, socket-scoped `dev.emit` seam, the
 * same one `unclaimed-adapters.visual.spec.ts` uses. Note the roster rides
 * `status.wifi` (replaced wholesale) rather than the `wifi` broadcast, which
 * carries only operation RESULTS: no shipped mock scenario
 * carries a capability report, and inventing one in the mock providers would be
 * a second mechanism for a state the wire already models.
 *
 * PNGs land in CeraUI/test-results/ (repo-local, gitignored — Rule D).
 */

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../../../test-results");

/** Rock 5B+ / RTL8852BE, verbatim from todo 2's board capture. */
const ROCK_RTL8852BE = {
	phy: "phy0",
	generation: "wifi6",
	bands: ["2.4", "5"],
	maxWidthMhz: { "2.4": 40, "5": 80 },
	apModes: ["2.4", "5"],
	staApCombo: { supported: true, sameChannelOnly: true },
	wpa3Sae: "supported",
	regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
};

/** MT7925-class: EHT, a real 6 GHz band, a domain that permits it. */
const MT7925 = {
	phy: "phy0",
	generation: "wifi7",
	bands: ["2.4", "5", "6"],
	maxWidthMhz: { "2.4": 40, "5": 160, "6": 320 },
	apModes: ["2.4", "5", "6"],
	staApCombo: { supported: true, sameChannelOnly: false },
	wpa3Sae: "supported",
	regulatory: { country: "US", is6GhzLegal: true, self_managed: true },
};

function radio(capabilities?: unknown) {
	return {
		ifname: "wlan0",
		conn: "home-uuid",
		hw: "Wi-Fi adapter",
		saved: {},
		available: [
			{ active: true, ssid: "CERALIVE", signal: 74, security: "WPA2", freq: 5180 },
		],
		...(capabilities ? { capabilities } : {}),
	};
}

/**
 * Serialized into the page via addInitScript, so it MUST be self-contained
 * (Playwright injects `fn.toString()`). Same harness shape as the adapters
 * spec, under its own global so the two never collide.
 */
function installWifiHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__wifiCaps) return;
	const Real = w.WebSocket;
	w.__wifiCaps = {
		socket: null,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__wifiCaps.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `wificaps-emit-${++w.__wifiCaps._seq}`,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
		},
	};
	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__wifiCaps.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}
	}
	w.WebSocket = HookedWS;
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) =>
			(
				window as unknown as { __wifiCaps: { emit(t: string, p: unknown): void } }
			).__wifiCaps.emit(t, p),
		[type, payload] as const,
	);
}

async function shoot(page: Page, name: string): Promise<void> {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	const section = page.getByTestId("wifi-capabilities").first();
	const target = (await section.count())
		? section.locator("xpath=ancestor::section[1]")
		: page.getByTestId("wifi-no-adapter").locator("xpath=ancestor::section[1]");
	await target.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
}

test.describe("@visual per-adapter Wi-Fi capability strip", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Network destination",
		);
		await page.addInitScript(installWifiHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test(
		"a Wi-Fi 6 radio offers its two bands and no 6 GHz at all",
		{ tag: "@visual" },
		async ({ page }) => {
			await emit(page, "status", { wifi: { 0: radio(ROCK_RTL8852BE) } });

			const strip = page.getByTestId("wifi-capabilities");
			await expect(strip).toBeVisible();
			await expect(page.getByTestId("wifi-generation-badge")).toHaveText("Wi-Fi 6");
			await expect(page.getByTestId("wifi-band-option")).toHaveCount(2);
			// The radio positively lacks Band 4, so 6 GHz contributes nothing —
			// not a greyed chip, and not a reason blaming the regulatory domain.
			await expect(page.locator('[data-band="6"]')).toHaveCount(0);
			await expect(page.getByTestId("wifi-band-blocked-reason")).toHaveCount(0);
			await expect(page.getByTestId("wifi-sta-ap-combo")).toHaveAttribute(
				"data-same-channel",
				"true",
			);

			await shoot(page, "wifi-dynamic-ui-wifi6");
		},
	);

	test(
		"a Wi-Fi 7 radio offers 6 GHz when its domain permits it",
		{ tag: "@visual" },
		async ({ page }) => {
			await emit(page, "status", { wifi: { 0: radio(MT7925) } });

			await expect(page.getByTestId("wifi-generation-badge")).toHaveText("Wi-Fi 7");
			await expect(page.getByTestId("wifi-band-option")).toHaveCount(3);
			await expect(
				page.locator('[data-testid="wifi-band-option"][data-band="6"]'),
			).toHaveAttribute(
				"data-available",
				"true",
			);
			await expect(page.getByTestId("wifi-band-blocked-reason")).toHaveCount(0);

			await shoot(page, "wifi-dynamic-ui-wifi7");
		},
	);

	test(
		"a forbidden 6 GHz band stays visible and reaches the country dialog",
		{ tag: "@visual" },
		async ({ page }) => {
			await emit(page, "status", {
				wifi: {
					0: radio({
						...MT7925,
						regulatory: { country: "CO", is6GhzLegal: false, self_managed: false },
					}),
				},
			});

			const six = page.locator('[data-testid="wifi-band-option"][data-band="6"]');
			await expect(six).toBeVisible();
			await expect(six).toHaveAttribute("data-available", "false");
			await expect(six).toHaveAttribute("aria-disabled", "true");

			const reason = page.getByTestId("wifi-band-blocked-reason");
			await expect(reason).toBeVisible();
			await expect(reason).toContainText("CO");

			await shoot(page, "wifi-dynamic-ui-6ghz-blocked");

			// The lazily-imported dialog really does resolve and open — the one
			// claim only a live browser can settle.
			await page.getByTestId("wifi-open-country").click();
			await expect(page.getByTestId("wifi-country-list")).toBeVisible();
		},
	);

	test(
		"a board with no Wi-Fi radio says so",
		{ tag: "@visual" },
		async ({ page }) => {
			await emit(page, "status", { wifi: {} });

			const empty = page.getByTestId("wifi-no-adapter");
			await expect(empty).toBeVisible();
			await expect(empty).toHaveAttribute("role", "status");
			await expect(page.getByTestId("wifi-capabilities")).toHaveCount(0);

			await shoot(page, "wifi-dynamic-ui-no-adapter");
		},
	);
});
