import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the "adapter present, no driver" band.
 *
 * The PNG is the artifact; every criterion below is ASSERTED, so a reviewer is
 * never asked to eyeball whether the band is right. Two facts are proven here
 * that a jsdom unit test structurally cannot:
 *
 *   • the band is REACHABLE on the real Network destination, rendered by the
 *     shipped `getStatus()?.unclaimed_adapters` wiring rather than by props a
 *     test handed the component directly;
 *   • it introduces NO interactive element to a page full of them — the
 *     never-gates invariant, measured against the live DOM.
 *
 * The state is injected through the dev-only, socket-scoped `dev.emit`, the same
 * seam `audit-network.spec.ts` uses for the netif collision bands: no shipped
 * mock scenario carries an undriven adapter, and inventing one in the mock
 * providers would be a second mechanism for a state the wire already models.
 *
 * PNG lands in CeraUI/test-results/ (repo-local, gitignored — Rule D).
 */

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../../../test-results");

/**
 * Serialized into the page via addInitScript, so it MUST be self-contained
 * (Playwright injects `fn.toString()`). Verbatim shape of the harness in
 * `audit-network.spec.ts`, under its own global so the two never collide.
 */
function installStatusHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__adapters) return;
	const Real = w.WebSocket;
	w.__adapters = {
		socket: null,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__adapters.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `adapters-emit-${++w.__adapters._seq}`,
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
			w.__adapters.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}
	}
	w.WebSocket = HookedWS;
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) =>
			(
				window as unknown as { __adapters: { emit(t: string, p: unknown): void } }
			).__adapters.emit(t, p),
		[type, payload] as const,
	);
}

test.describe("@visual undriven wireless/BT adapter band", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the Network destination");
		await page.addInitScript(installStatusHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test("an all-driven host shows no band at all", { tag: "@visual" }, async ({ page }) => {
		// The positive answer "every adapter here is driven" must be silent — the
		// band exists to break a silence, not to add one.
		await emit(page, "status", { unclaimed_adapters: [] });
		await expect(page.getByTestId("unclaimed-adapters-info")).toHaveCount(0);
	});

	test("an undriven adapter is named, and gates nothing", { tag: "@visual" }, async ({ page }) => {
		await emit(page, "status", {
			unclaimed_adapters: [
				{ bus: "pci", vendorId: "14c3", deviceId: "7961", kind: "wifi" },
				{ bus: "usb", vendorId: "0bda", deviceId: "b82c", kind: "bluetooth" },
			],
		});

		const band = page.getByTestId("unclaimed-adapters-info");
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute("role", "status");

		const rows = page.getByTestId("unclaimed-adapter");
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText("14c3:7961");
		await expect(rows.nth(1)).toContainText("0bda:b82c");

		// NEVER GATES: the band contributes no control to a page full of them.
		expect(
			await band.evaluate(
				(el) =>
					el.querySelectorAll("button, a, input, select, textarea, [role='button'], [role='switch']")
						.length,
			),
		).toBe(0);

		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
		await band.screenshot({ path: path.join(EVIDENCE_DIR, "unclaimed-adapter-band.png") });
	});
});
