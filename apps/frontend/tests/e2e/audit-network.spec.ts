import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Audit A2 — Network destination coherence walk (live-correctness-pass Todo #16),
 * @audit. Default worker scenario = `multi-modem-wifi` (WiFi + 3 modems + eth).
 *
 * This file is the primary of a THREE-file audit set (one MOCK_SCENARIO per file,
 * per the worker-scoped `backendScenario` constraint — see PLAYBOOK.md → Per-Worker
 * Backend Scenario Override):
 *   • audit-network.spec.ts              — multi-modem-wifi (this file)
 *   • audit-network-single-modem.spec.ts — single-modem (no WiFi)
 *   • audit-network-pin.spec.ts          — modem-pin-locked (full SIM PIN walk)
 *
 * Checklist verified here (rendered-DOM, PLAYBOOK-compliant — role/testid/web-first
 * assertions, no screenshots, no fixed-delay waits):
 *   1. Bonded-links section is the SOLE owner of per-link telemetry (RTT/NAK/weight
 *      never duplicated outside BondedLinksSection).
 *   2. WiFi scan/connect surfaces dispatch through osCommand with an in-flight state.
 *   3. Modem config dialog validates the manual-APN schema bound (mirrors the
 *      backend zod refine: autoconfig !== false || apn.length > 0).
 *   4. CollisionBands render ONLY from their netif flags (same_subnet_group /
 *      policy_route_missing) — absent by default, present once injected.
 *   5. Disabled controls carry an accessible reason (BondToggle tooltip/aria-label).
 *
 * netif flags for check #4 are injected through the dev-only `dev.emit` broadcast
 * (socket-scoped, seq-advanced, so it merges into the live netif snapshot exactly
 * like a real tick) — the same pattern sim-pin-unlock.spec uses for `modems`.
 */

/**
 * Serialized into the page via addInitScript, so it MUST be self-contained
 * (Playwright injects `fn.toString()`). Exposes `window.__net.emit(type, payload)`
 * which drives the backend `dev.emit` RPC; the backend re-broadcasts `{[type]:
 * payload}` to this socket only.
 */
function installNetworkHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__net) return;
	const Real = w.WebSocket;
	w.__net = {
		socket: null,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__net.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `net-emit-${++w.__net._seq}`,
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
			w.__net.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}
	}
	w.WebSocket = HookedWS;
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as unknown as { __net: { emit(t: string, p: unknown): void } }).__net.emit(t, p),
		[type, payload] as const,
	);
}

const findings: string[] = [];
const record = (line: string) => findings.push(line);

test.describe("Audit A2 — Network destination (multi-modem-wifi)", { tag: "@audit" }, () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser audit walk");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Network destination audit",
		);
		await page.addInitScript(installNetworkHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test.afterAll(() => {
		fs.writeFileSync(
			evidencePath("audit-network-multi-modem-wifi.txt"),
			[
				"Audit A2 — Network destination coherence (multi-modem-wifi)",
				`Generated: ${new Date().toISOString()}`,
				"",
				...findings,
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("bonded-links section is the SOLE owner of per-link telemetry (RTT/NAK/weight)", async ({
		page,
	}) => {
		// Bonded links render for every enabled interface in multi-modem-wifi.
		await expect(page.getByTestId("bonded-link-card").first()).toBeVisible({ timeout: 15_000 });

		const telemetry = page.getByTestId("link-telemetry");
		const total = await telemetry.count();
		expect(total).toBeGreaterThan(0);

		// Every telemetry cluster in the DOM must live inside a bonded-link-card:
		// the per-interface WiFi/Cellular/Ethernet rows must NOT duplicate it.
		const outside = await telemetry.evaluateAll(
			(els) => els.filter((el) => el.closest('[data-testid="bonded-link-card"]') === null).length,
		);
		expect(outside).toBe(0);

		// And the RTT/NAK/weight value cells (the exact numbers the rule forbids
		// duplicating) are all inside bonded cards too.
		for (const testid of ["link-rtt", "link-nak", "link-weight"]) {
			const stray = await page
				.getByTestId(testid)
				.evaluateAll(
					(els) => els.filter((el) => el.closest('[data-testid="bonded-link-card"]') === null).length,
				);
			expect(stray, `${testid} must not render outside BondedLinksSection`).toBe(0);
		}
		record(
			`#1 sole-telemetry rule: ${total} link-telemetry clusters, 0 outside bonded-link-card (RTT/NAK/weight not duplicated) — PASS`,
		);
	});

	test("WiFi scan dispatches through osCommand and shows an in-flight state", async ({ page }) => {
		const trigger = page.getByTestId("open-wifi-selector-dialog");
		await expect(trigger).toBeVisible();
		// multi-modem-wifi has a WiFi radio → the Connect trigger is enabled.
		await expect(trigger).toBeEnabled();
		await trigger.click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		const scan = page.getByTestId("wifi-scan-button");
		await expect(scan).toBeEnabled();
		await scan.click();

		// osCommand pending → the scan button disables + an in-flight spinner appears.
		await expect(scan).toBeDisabled();
		await expect(page.getByTestId("wifi-scan-status")).toBeVisible();
		record(
			"#2 WiFi scan: dispatched via osCommand → button disabled + wifi-scan-status spinner shown (in-flight) — PASS",
		);
	});

	test("modem config dialog validates the manual-APN schema bound", async ({ page }) => {
		await page.getByTestId("open-modem-config-dialog").first().click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		// Manual-APN mode (the APN field renders). Clearing the APN violates the
		// schema refine (mirrors the backend zod: autoconfig !== false || apn.length
		// > 0): aria-invalid on the field + the primary Save action disabled.
		const apn = dialog.locator("#modem-apn");
		await expect(apn).toBeVisible();
		await apn.fill("");
		await expect(apn).toHaveAttribute("aria-invalid", "true");

		const save = dialog.locator("[data-app-dialog-footer] button").last();
		await expect(save).toBeDisabled();

		// Providing an APN satisfies the bound → field valid + Save enabled.
		await apn.fill("internet");
		await expect(apn).toHaveAttribute("aria-invalid", "false");
		await expect(save).toBeEnabled();
		record(
			"#3 modem config: cleared manual APN → aria-invalid + Save disabled; filled APN → valid + Save enabled (mirrors backend zod refine) — PASS",
		);
	});

	test("CollisionBands render only from their netif flags", async ({ page }) => {
		const subnet = page.getByTestId("same-subnet-info");
		const policy = page.getByTestId("policy-route-warning");

		// multi-modem-wifi's bonded links legitimately share a subnet, so the calm
		// same-subnet info band is already present and reflects the real netif
		// same_subnet_group flag (a CIDR). The amber policy-route warning is NOT —
		// no interface carries policy_route_missing on a dev/mock host.
		// The band renders only once the first netif broadcast lands, which can lag
		// the default 5s on a cold-start worker — wait 15s (matches the sibling
		// bonded-link-card wait above, same netif-driven content).
		await expect(subnet).toBeVisible({ timeout: 15_000 });
		await expect(subnet).toHaveAttribute("role", "status");
		await expect(subnet).toContainText(/\d+\.\d+\.\d+\.\d+\/\d+/);
		await expect(policy).toHaveCount(0);

		// Inject the two flags via dev.emit (merges per-interface, subscriptions
		// netif case): a new CIDR must surface in the info band and the injected
		// policy_route_missing must raise the warning band — proving BOTH bands are
		// driven purely by their netif flags.
		await emit(page, "netif", {
			"audit-lan-a": {
				tp: 0,
				enabled: false,
				ip: "192.168.77.2",
				same_subnet_group: "192.168.77.0/24",
			},
			"audit-lan-b": { tp: 0, enabled: false, ip: "192.168.77.3", policy_route_missing: true },
		});

		await expect(subnet).toContainText("192.168.77.0/24");
		await expect(policy).toBeVisible();
		record(
			"#4 CollisionBands: same-subnet band reflects the real netif CIDR; policy-route-warning absent until policy_route_missing injected; injected CIDR surfaced — PASS",
		);
	});

	test("disabled bond toggles carry an accessible reason", async ({ page }) => {
		// A bonded modem/wifi/eth row exposes a bond toggle. Any toggle that is
		// rendered disabled must carry a non-empty accessible label (tooltip reason
		// or action label) — never a silent dead control.
		const toggles = page.locator('[data-testid^="bond-toggle-"]');
		await expect(toggles.first()).toBeVisible({ timeout: 15_000 });

		const disabledWithoutReason = await toggles.evaluateAll((els) =>
			els
				.filter((el) => el.getAttribute("disabled") !== null || el.getAttribute("aria-disabled") === "true")
				.filter((el) => {
					const label = el.getAttribute("aria-label") ?? "";
					return label.trim().length === 0;
				}).length,
		);
		expect(disabledWithoutReason, "every disabled bond toggle must carry an aria-label reason").toBe(0);
		record(
			"#5 disabled controls: all bond toggles expose an aria-label reason (tooltip-backed) — PASS",
		);
	});
});
