import { encoderLoadSchema } from "@ceraui/rpc/schemas";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import ar from "../../../../packages/i18n/messages/ar.json" with { type: "json" };
import de from "../../../../packages/i18n/messages/de.json" with { type: "json" };
import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import fr from "../../../../packages/i18n/messages/fr.json" with { type: "json" };
import hi from "../../../../packages/i18n/messages/hi.json" with { type: "json" };
import ptBR from "../../../../packages/i18n/messages/pt-BR.json" with { type: "json" };
import { mockIslandLoadAt } from "../../src/lib/streaming/encoder-load-island-mock";
import { expect, test } from "./fixtures/index.js";
import { isBackendSocket } from "./helpers/backend-socket.js";
import { gridFitProblems, readGridFit } from "./helpers/grid-fit.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";
import { openModemAdvanced } from "./helpers/modem-advanced.js";

/**
 * Dense telemetry readouts follow their card, not the window: Device Health's
 * now strip, Media load's per-core figures, and the modem dialog's serving-cell
 * and signal strips. Each is swept as a phone from 320 to 641 px, in a desktop
 * window, and in a narrow card inside that window, in six locales. No caption or
 * value may reach past its cell, clip, or break inside a word, and the narrow
 * card must drop to two columns while the desktop window keeps the full grid.
 * Each test sets its own device and viewports, so the desktop project alone runs it.
 */

const LOCALES = { ar, de, en, fr, hi, "pt-BR": ptBR } as const;
const PHONE_WIDTHS = [320, 390, 412, 540, 641] as const;
// A build string the engine reports, longer than the encoder band's header has room for.
const ENGINE_REVISION = "2026.11.4-rc.3+g8a8ab518d4f2c0e1";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** A readout's grids; `desktopColumns` pins a grid's full width, and its narrow form is two. */
type Readout = { name: string; grids: (dialog: Locator) => Locator[]; desktopColumns?: number };

async function openLocale(page: Page, locale: string, messages: typeof en, destination: "settings" | "network"): Promise<void> {
	await page.addInitScript((code) => {
		localStorage.setItem("locale", JSON.stringify({ code }));
	}, locale);
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, destination);
	await expect(page.locator("html")).toHaveAttribute("lang", locale);
	// A touch browser is offered the install banner first.
	const installPrompt = page.getByRole("button", { name: messages["pwa.installIosGotIt"], exact: true });
	await installPrompt.click();
	await expect(installPrompt).toHaveCount(0);
}

/** Every readout at 12 px or more, whole and inside the dialog, at each width. */
async function sweep(page: Page, dialog: Locator, locale: string, readouts: Readout[]): Promise<string[]> {
	const problems: string[] = [];
	const check = async (where: string, columnsOf: (readout: Readout) => number | undefined) => {
		for (const readout of readouts) {
			for (const [index, grid] of readout.grids(dialog).entries()) {
				const fit = await readGridFit(grid, dialog);
				const options = { columns: columnsOf(readout), minFontPx: 12 };
				problems.push(...gridFitProblems(`${locale} ${readout.name}#${index} ${where}`, fit, options));
			}
		}
	};
	for (const width of PHONE_WIDTHS) {
		await page.setViewportSize({ width, height: 844 });
		await check(`at ${width} px`, () => undefined);
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	await check("at 1280 px", (readout) => readout.desktopColumns);
	await dialog.evaluate((el) => {
		el.style.maxWidth = "22.5rem";
	});
	await check("in a 22.5rem dialog at 1280 px", (readout) => (readout.desktopColumns === undefined ? undefined : 2));
	await dialog.evaluate((el) => {
		el.style.maxWidth = "";
	});
	return problems;
}

test.describe("dense telemetry readouts fit their card @desktop-only", () => {
	// A phone draws overlay scrollbars, so the sweep measures the card a phone gets.
	test.use({ isMobile: true, hasTouch: true });

	for (const [locale, messages] of Object.entries(LOCALES)) {
		test(`${locale}: Device Health now strip`, async ({ page }) => {
			// The engine reports a long build; every other frame stays the backend's.
			let socket: WebSocketRoute | undefined;
			await page.routeWebSocket(isBackendSocket, (ws) => {
				socket = ws;
				const server = ws.connectToServer();
				ws.onMessage((message) => server.send(message));
				server.onMessage((message) => {
					const frame: unknown = typeof message === "string" ? JSON.parse(message) : undefined;
					if (!isRecord(frame) || !isRecord(frame.revisions)) {
						ws.send(message);
						return;
					}
					ws.send(JSON.stringify({ ...frame, revisions: { ...frame.revisions, cerastream: ENGINE_REVISION } }));
				});
			});
			await openLocale(page, locale, messages, "settings");
			if (!socket) throw new Error("Settings control socket was not routed");
			socket.send(JSON.stringify({ revisions: { cerastream: ENGINE_REVISION } }));
			await page.getByTestId("settings-entry-deviceHealth").click();
			const dialog = page.getByRole("dialog", { name: messages["settings.deviceHealth.title"], exact: true });
			// Populated: the temperature's change over the window and the load's peak.
			await expect(dialog.getByTestId("health-fact-temp")).toContainText("Δ", { timeout: 15_000 });
			const readouts: Readout[] = [
				{ name: "now", grids: (d) => [d.getByTestId("device-health-now")], desktopColumns: 3 },
				{ name: "loads", grids: (d) => [d.getByTestId("device-health-loads")] },
			];
			const problems = await sweep(page, dialog, locale, readouts);

			// The engine build is the one string here that may shorten: whole in its
			// title, and at 12 px like everything else.
			const chip = dialog.getByTestId("device-health-engine-revision");
			await expect(chip).toContainText(ENGINE_REVISION);
			const shown = await chip.evaluate((el) => ({
				title: el.querySelector("[title]")?.getAttribute("title") ?? null,
				fonts: [...el.querySelectorAll("span")].map((span) => Number.parseFloat(getComputedStyle(span).fontSize)),
			}));
			if (shown.title !== ENGINE_REVISION) problems.push(`${locale} engine build chip's title is ${JSON.stringify(shown.title)}`);
			if (Math.min(...shown.fonts) < 12) problems.push(`${locale} engine build chip is ${Math.min(...shown.fonts)} px, below 12 px`);

			// The 1024x600 kiosk keeps its compact strip on one screen: nothing scrolls.
			await page.setViewportSize({ width: 1024, height: 600 });
			for (const readout of readouts) {
				for (const grid of readout.grids(dialog)) {
					problems.push(...gridFitProblems(`${locale} ${readout.name} on the 1024x600 kiosk`, await readGridFit(grid, dialog), { minFontPx: 12 }));
				}
			}
			const body = await dialog.getByTestId("device-health").evaluate((el) => {
				const scroller = el.closest<HTMLElement>(".overflow-y-auto");
				return scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
			});
			if (!body || body.scrollHeight > body.clientHeight + 1) {
				problems.push(`${locale} Device Health scrolls on the 1024x600 kiosk: ${JSON.stringify(body)}`);
			}
			expect(problems).toEqual([]);
		});

		test(`${locale}: Media load per-core figures`, async ({ page, pageRpc }) => {
			await openLocale(page, locale, messages, "settings");
			await pageRpc.call(["dev", "emit"], { type: "encoder-load", payload: encoderLoadSchema.parse(mockIslandLoadAt(Date.now())) });
			const hint = page.getByTestId("media-load-hint");
			await expect(hint).toHaveAttribute("data-core-count", "8");
			await hint.getByTestId("open-media-load-dialog").click();
			const dialog = page.getByRole("dialog", { name: messages["settings.mediaLoad.title"], exact: true });
			await expect(dialog.getByTestId("media-detail-core")).toHaveCount(8);
			const cores: Readout = {
				name: "core",
				grids: (d) => [0, 1, 2, 3, 4, 5, 6, 7].map((n) => d.getByTestId("media-detail-core").nth(n).locator("dl")),
				desktopColumns: 3,
			};
			expect(await sweep(page, dialog, locale, [cores])).toEqual([]);
		});

		test(`${locale}: modem serving cell and signal`, async ({ page }) => {
			// The injected roster is the only truth on screen: the worker backend's own
			// status, config, interface and modem frames are dropped.
			let socket: WebSocketRoute | undefined;
			await page.routeWebSocket(isBackendSocket, (ws) => {
				socket = ws;
				const server = ws.connectToServer();
				ws.onMessage((message) => server.send(message));
				server.onMessage((message) => {
					const frame: unknown = typeof message === "string" ? JSON.parse(message) : undefined;
					if (isRecord(frame) && ("status" in frame || "config" in frame || "netif" in frame || "modems" in frame)) return;
					ws.send(message);
				});
			});
			await openLocale(page, locale, messages, "network");
			if (!socket) throw new Error("Network control socket was not routed");
			socket.send(JSON.stringify({ config: { srtla_addr: "127.0.0.1", srtla_port: 5000, srt_streamid: "e2e", max_br: 6000, pipeline: "hdmi", modem_provisioning: true } }));
			const carrier = "Telefónica Movistar Colombia";
			socket.send(JSON.stringify({ status: { modems: { "mm-healthy": {
				ifname: "wwan0", name: "Quectel RM520N", network_type: { supported: ["5g", "lte"], active: "lte" },
				config: { apn: "", username: "", password: "", roaming: false, network: "" },
				status: { connection: "connected", network_type: "lte", signal: 71, roaming: false, network: carrier },
				no_sim: false, device_class: "usb", slot_label: "SIM 1", stable_key: "pci-0000:00:14.0-usb-0:2",
				usb_mode: "rndis", recommended_usb_mode: "mbim", firmware_revision: "RM520NGLAAR01A08M4G",
				cell_info: { tech: "nr", band: "n78", cell_id: "0x1A2B3C4D", rsrp: -112, rsrq: -11, sinr: 18, provenance: { source: "qmi", observed_at: 1_770_000_000 } },
				signal_detail: {
					quality_recent: { state: "known", value: true },
					rsrp: { state: "known", value: -112 },
					rsrq: { state: "known", value: -11 },
					snr: { state: "known", value: 7 },
					sinr: { state: "unknown", reason: "not-reported" },
				},
				registration_context: {
					operator_name: { state: "known", value: carrier },
					operator_code: { state: "known", value: "732123" },
					cell_id: { state: "unknown", reason: "not-observed" },
					tac: { state: "unknown", reason: "not-observed" },
				},
			} } } }));
			const row = page.locator('[data-testid="modem-row"][data-modem-id="mm-healthy"]');
			await row.getByTestId("open-modem-config-dialog").click();
			const dialog = page.getByRole("dialog", { name: "Quectel RM520N", exact: true });
			await expect(dialog).toBeVisible({ timeout: 15_000 });
			await openModemAdvanced(dialog);
			const cell: Readout = { name: "cell", grids: (d) => [d.getByTestId("modem-cell-info")], desktopColumns: 3 };
			const signal: Readout = { name: "signal", grids: (d) => [d.getByTestId("modem-signal-strip")], desktopColumns: 4 };
			expect(await sweep(page, dialog, locale, [cell, signal])).toEqual([]);
		});
	}
});
