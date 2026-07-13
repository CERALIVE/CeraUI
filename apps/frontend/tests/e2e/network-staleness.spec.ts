import fs from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Task 22 — per-interface staleness + consistent loading feedback.
 *
 * Two outcomes, proven against the real stack (local Vite dev :6173 with
 * `__ceraSocketPort` selecting a 31xx worker backend, or CI production preview
 * :6173 with cookie-based admission to that worker backend;
 * MOCK_SCENARIO=multi-modem-wifi):
 *
 *   1. Per-interface staleness: with telemetry flowing for every modem, freeze
 *      ONE modem's updates while the others keep refreshing. Only the frozen
 *      interface earns a "Stale" badge; the fresh siblings stay unmarked. This
 *      is the case a whole-source timestamp can never catch, so it exercises the
 *      per-interface fingerprint path in `hud.svelte.ts`.
 *   2. Loading feedback: a manual WiFi scan surfaces the standard InlineSpinner
 *      ("Scanning") and then resolves.
 *
 * Staleness selectivity needs the server→client modem stream under test control,
 * so the WS is proxied (`routeWebSocket`): real frames flow until takeover, then
 * server-originated `modems` frames are dropped and replaced by injected ones.
 * Injected broadcast frames carry no `seq`, so they bypass the drop-stale guard
 * (client.ts). `is_streaming:true` keeps the HUD staleness clock ticking (the
 * gate documented in hud.svelte.ts) — no new polling is introduced anywhere.
 */

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(fileName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			"Task 22 — CeraUI per-interface staleness + loading feedback",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

type ModemRecord = Record<
	string,
	{ ifname?: string; no_sim?: boolean; status?: { signal?: number } }
>;

test.describe("Task 22 — per-interface staleness", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test("freezing one modem marks only it stale; fresh siblings unaffected", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the sections");

		// Proxy the WS so the frozen interface's update stream is under test
		// control. An interface is "fresh" while ANY of its sources (modem signal
		// OR netif throughput) keeps changing, so to freeze one interface we must
		// silence BOTH its modem frames and its netif throughput.
		let serverModems: ModemRecord = {};
		let takeover = false;
		let frozenIfname = "";
		let pageWs: import("@playwright/test").WebSocketRoute | null = null;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					// The backend broadcasts modems nested under `status`
					// (broadcastModems → broadcastMsg("status", { modems })).
					const frame = JSON.parse(text) as {
						modems?: ModemRecord;
						status?: { modems?: ModemRecord };
						netif?: Record<string, unknown>;
					};
					const modems = frame?.status?.modems ?? frame?.modems;
					if (modems && typeof modems === "object") {
						serverModems = { ...serverModems, ...modems };
						if (takeover) return;
					}
					// After takeover, drop the frozen interface's netif throughput
					// so its fingerprint stops advancing; forward everything else.
					if (takeover && frozenIfname && frame?.netif?.[frozenIfname]) {
						delete frame.netif[frozenIfname];
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

		// Wait until the Cellular section has rendered real modem rows.
		const cellular = page
			.getByRole("heading", { name: "Cellular", level: 2 })
			.locator("xpath=ancestor::section[1]");
		await expect(cellular).toBeVisible();
		await expect
			.poll(() => Object.keys(serverModems).length, {
				timeout: 15_000,
				message: "at least two modems should arrive from the mock backend",
			})
			.toBeGreaterThanOrEqual(2);

		// Pick a frozen modem + its fresh siblings (SIM-bearing modems only — a
		// no-SIM slot has no live telemetry to go stale).
		const simModems = Object.entries(serverModems).filter(
			([, m]) => m.no_sim !== true && m.ifname,
		);
		expect(simModems.length).toBeGreaterThanOrEqual(2);
		const frozenKey = simModems[0]![0];
		frozenIfname = simModems[0]![1].ifname as string;
		const freshIfnames = simModems.slice(1).map(([, m]) => m.ifname as string);
		record(`modems: ${simModems.map(([, m]) => m.ifname).join(", ")}`);
		record(`frozen: ${frozenIfname}; fresh: ${freshIfnames.join(", ")}`);

		// Keep the staleness clock running.
		pageWs!.send(JSON.stringify({ status: { is_streaming: true } }));

		// Take over the modem stream; from here only injected frames update it.
		takeover = true;
		const baseline = JSON.parse(JSON.stringify(serverModems)) as ModemRecord;

		// Both layouts (desktop + mobile) mount; the hidden one is filtered by
		// `:visible` so each interface resolves to a single badge.
		const staleBadge = (ifname: string) =>
			page.locator(`[data-stale-interface="${ifname}"]:visible`);

		let tick = 0;
		await expect
			.poll(
				async () => {
					tick += 1;
					// Keep the staleness clock alive and re-emit: fresh modems get a
					// changing signal; the frozen one keeps its baseline value, so its
					// fingerprint never advances.
					pageWs!.send(JSON.stringify({ status: { is_streaming: true } }));
					const next = JSON.parse(JSON.stringify(baseline)) as ModemRecord;
					for (const [key, modem] of Object.entries(next)) {
						if (key === frozenKey) continue;
						if (modem.status) modem.status.signal = 30 + (tick % 50);
					}
					pageWs!.send(JSON.stringify({ modems: next }));
					return staleBadge(frozenIfname).count();
				},
				{
					timeout: 20_000,
					intervals: [500, 800, 1000],
					message: "frozen modem should earn a stale badge",
				},
			)
			.toBeGreaterThan(0);

		// The layout mounts each section in both responsive variants, so dedupe
		// by ifname: the set of visibly-stale interfaces must be exactly {frozen}.
		const staleIds = [
			...new Set(
				await page
					.locator("[data-stale-interface]:visible")
					.evaluateAll((els) =>
						els.map((e) => e.getAttribute("data-stale-interface")),
					),
			),
		];
		expect(staleIds).toEqual([frozenIfname]);
		for (const ifname of freshIfnames) {
			expect(staleIds).not.toContain(ifname);
		}

		record(
			`stale badge present ONLY for ${frozenIfname}; fresh ${freshIfnames.join(", ")} unmarked ✓`,
		);
		writeEvidence("task-22-staleness.txt", [
			"Outcome 1 — per-interface staleness (NetworkView/Cellular)",
			...evidence,
			"",
			"Result: PASS — one frozen interface dims+badges; fresh siblings unaffected.",
		]);
	});
});

test.describe("Task 22 — consistent loading feedback", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test("WiFi scan shows a loading indicator that then resolves", async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the dialog");

		await navigateTo(page, "network");

		const open = page.getByTestId("open-wifi-selector-dialog").first();
		await expect(open).toBeEnabled({ timeout: 15_000 });
		await open.click();

		const dialog = page.getByRole("dialog", { name: "Available Networks" });
		await expect(dialog).toBeVisible();

		const scanButton = page.getByTestId("wifi-scan-button");
		const scanStatus = page.getByTestId("wifi-scan-status");

		await scanButton.click();
		// Loading indicator appears (the standard InlineSpinner, role=status).
		await expect(scanStatus).toBeVisible();
		await expect(scanButton).toBeDisabled();

		// …then resolves once fresh scan results land (or the safety net fires).
		await expect(scanStatus).toBeHidden({ timeout: 22_000 });
		await expect(scanButton).toBeEnabled();

		writeEvidence("task-22-loading.txt", [
			"Outcome 2 — standardized loading feedback (WiFi scan)",
			'Opened the WiFi selector dialog and clicked "Scan".',
			'InlineSpinner (role="status", testid=wifi-scan-status) appeared; scan button disabled.',
			"Indicator resolved (hidden) and the scan button re-enabled.",
			"",
			"Result: PASS — the in-flight action never looks frozen.",
		]);
	});
});
