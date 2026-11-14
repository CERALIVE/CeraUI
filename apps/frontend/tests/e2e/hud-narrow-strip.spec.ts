import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated } from "./helpers/index.js";

/**
 * The persistent HUD strip has to keep its four facts readable at every width:
 * the verdict (lifecycle badge + health + reason), the bitrate, the link badges
 * and the temperature. jsdom cannot measure layout, so this drives the real app
 * over its socket and checks the rendered geometry.
 *
 * Each case runs with a long health reason and walks the three bitrate forms
 * the strip can show while live:
 *   - short:     the engine target alone ("12.5 Mbps")
 *   - measured:  measured throughput plus its target ("19.9 Mbps Target 18.5 Mbps")
 *   - throttled: measured, target and the configured limit
 */

type Form = "short" | "measured" | "throttled";
const FORMS: Record<Form, { applied: number; maxBr: number; measuredBps: number | null }> = {
	short: { applied: 12500, maxBr: 12500, measuredBps: null },
	measured: { applied: 18500, maxBr: 18500, measuredBps: 19_900_000 },
	throttled: { applied: 18500, maxBr: 25000, measuredBps: 19_900_000 },
};

const LONG_REASON =
	"Video frames have stopped advancing for a while and the connection is being checked";

type Case = { locale: string; width: number; height: number; touch?: boolean };
const CASES: Case[] = [
	...[320, 360, 390, 430, 768, 1024].map((width) => ({ locale: "en", width, height: 844 })),
	{ locale: "en", width: 1024, height: 600, touch: true },
	{ locale: "de", width: 320, height: 844 },
	{ locale: "de", width: 360, height: 844 },
	{ locale: "de", width: 390, height: 844 },
	{ locale: "es", width: 320, height: 844 },
	{ locale: "es", width: 360, height: 844 },
];

/** Sub-pixel rounding. */
const TOL = 1;

type Box = { left: number; right: number; width: number };

async function installSocket(page: Page, current: () => Form) {
	let route: WebSocketRoute | undefined;
	let lastStatus: Record<string, unknown> | undefined;
	let lastConfig: Record<string, unknown> | undefined;
	const status = (frame: Record<string, unknown>) => {
		const form = FORMS[current()];
		return {
			...frame,
			is_streaming: true,
			engine_bitrate: { applied_kbps: form.applied },
			linkTelemetry:
				form.measuredBps == null ? null : { links: [], measured_bps: form.measuredBps },
		};
	};
	const config = (frame: Record<string, unknown>) => ({ ...frame, max_br: FORMS[current()].maxBr });
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => {
			try {
				const frame = JSON.parse(String(m));
				// The test owns the health verdict; drop the backend's own.
				if (frame.health) return;
				if (frame.sensors) {
					frame.sensors = { "SoC temperature": 45, "SoC voltage": 5, "SoC current": 1 };
				}
				if (frame.status) {
					lastStatus = frame.status;
					frame.status = status(frame.status);
				}
				if (frame.config) {
					lastConfig = frame.config;
					frame.config = config(frame.config);
				}
				ws.send(JSON.stringify(frame));
				return;
			} catch {}
			ws.send(m);
		});
	});
	return {
		sendHealth() {
			route?.send(
				JSON.stringify({
					health: {
						state: "degraded",
						reason: { component: "frames", detail: LONG_REASON },
						process: { alive: true },
						frames: { advancing: false, count: 0 },
						srt: { reconnecting: false, reconnectCount: 0 },
						bond: { linkCount: 2, activeLinks: 1 },
					},
				}),
			);
		},
		resend() {
			if (!lastStatus || !lastConfig) throw new Error("no status/config frame captured yet");
			route?.send(JSON.stringify({ config: config(lastConfig), status: status(lastStatus) }));
		},
	};
}

async function measure(page: Page) {
	return page.locator("[data-hud-region]").first().evaluate((strip) => {
		const box = (el: Element | null): Box | null => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right, width: r.width };
		};
		const q = (sel: string) => strip.querySelector(sel);
		const bitrate = q('[data-testid="hud-bitrate"]') as HTMLElement;
		const range = document.createRange();
		range.selectNodeContents(bitrate);
		const text = range.getBoundingClientRect();
		const temperature = strip.querySelectorAll(':scope > [role="img"]');
		const temp = temperature[temperature.length - 1] as HTMLElement;
		const links = q('[data-testid="strip-links"]');
		return {
			strip: { ...box(strip), clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth },
			lifecycle: box(q('[id$="-lifecycle"]')),
			health: box(q('[data-testid="stream-health"]')),
			reason: box(q('[data-testid="stream-health-reason"]')),
			bitrate: { ...box(bitrate), clientWidth: bitrate.clientWidth, scrollWidth: bitrate.scrollWidth },
			bitrateText: { left: text.left, right: text.right, width: text.width },
			temp: { ...box(temp), text: temp.textContent ?? "" },
			links: box(links),
			badges: [...(links?.children ?? [])]
				.map((el) => box(el))
				.filter((b): b is Box => b != null && b.width > 0),
		};
	});
}

for (const c of CASES) {
	const name = `${c.locale} ${c.width}x${c.height}${c.touch ? " touch" : ""}`;
	test(`HUD strip keeps its four facts apart at ${name}`, async ({ page }, info) => {
		test.skip(info.project.name !== "desktop");
		let form: Form = "short";
		const socket = await installSocket(page, () => form);
		await page.addInitScript((code: string) => {
			localStorage.setItem("locale", JSON.stringify({ code }));
		}, c.locale);
		await page.setViewportSize({ width: c.width, height: c.height });
		await page.goto(c.touch ? "/?mode=touch" : "/");
		await ensureAuthenticated(page);
		const strip = page.locator("[data-hud-region]").first();
		await expect(strip).toBeVisible({ timeout: 30000 });
		socket.sendHealth();
		await expect(page.getByTestId("stream-health-reason")).toBeVisible();

		const bitrate = page.getByTestId("hud-bitrate");
		for (const next of Object.keys(FORMS) as Form[]) {
			form = next;
			socket.resend();
			if (next === "short") await expect(bitrate).not.toHaveAttribute("data-measured", "true");
			else await expect(bitrate).toHaveAttribute("data-measured", "true");
			if (next === "throttled") await expect(bitrate).toHaveAttribute("data-below-limit", "true");
			else await expect(bitrate).not.toHaveAttribute("data-below-limit", "true");

			const g = await measure(page);
			const at = `${name}, ${next} bitrate`;
			// Nothing in the verdict paints into the bitrate.
			for (const [part, b] of [
				["lifecycle badge", g.lifecycle],
				["health label", g.health],
				["health reason", g.reason],
			] as const) {
				expect(b, `${part} renders (${at})`).not.toBeNull();
				expect(b?.right ?? 0, `${part} ends before the bitrate (${at})`).toBeLessThanOrEqual(
					(g.bitrate.left ?? 0) + TOL,
				);
			}
			// The bitrate shows its whole value.
			expect(g.bitrate.scrollWidth, `bitrate is not clipped (${at})`).toBeLessThanOrEqual(
				g.bitrate.clientWidth + TOL,
			);
			expect(g.bitrateText.right ?? 0, `bitrate text fits its box (${at})`).toBeLessThanOrEqual(
				(g.bitrate.right ?? 0) + TOL,
			);
			// The strip never overflows and the temperature stays on it.
			expect(g.strip.scrollWidth, `strip does not overflow (${at})`).toBeLessThanOrEqual(
				g.strip.clientWidth,
			);
			expect(g.temp.right ?? 0, `temperature stays inside the strip (${at})`).toBeLessThanOrEqual(
				(g.strip.right ?? 0) + TOL,
			);
			expect(g.temp.text, `temperature value is shown (${at})`).toContain("45");
			// From `sm` up there is room for links: a long reason must not push them
			// all out. Fully throttled (three bitrates) they may drop out, but whole.
			if (c.width >= 640 && next !== "throttled") {
				expect(g.badges.length, `at least one link badge shows (${at})`).toBeGreaterThan(0);
			}
			// A link badge is either shown whole or not at all, never a clipped sliver.
			for (const badge of g.badges) {
				expect(
					badge.left >= (g.links?.left ?? 0) - TOL && badge.right <= (g.links?.right ?? 0) + TOL,
					`link badge ${JSON.stringify(badge)} is whole inside ${JSON.stringify(g.links)} (${at})`,
				).toBe(true);
			}
		}
	});
}
