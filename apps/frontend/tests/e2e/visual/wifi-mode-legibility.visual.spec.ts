import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual NARROW-VIEWPORT legibility of the per-adapter Wi-Fi mode (todo 16).
 *
 * The acceptance criterion is a single sentence: at 375px, station / hotspot /
 * hybrid must be distinguishable WITHOUT opening a dialog. Two things make that
 * worth a browser rather than a jsdom test:
 *
 *   • jsdom lays nothing out, so it cannot answer whether the mode indicator
 *     truncates, wraps into the action cluster, or pushes the row off-screen —
 *     which is the whole question at 375px;
 *   • the three modes must differ on a channel that is NOT colour. Colour groups
 *     `hotspot` with `hybrid` (both broadcast, both `status-info`), truthfully,
 *     so the distinction rests on the WORD and the GLYPH. Those are compared
 *     here as rendered TEXT and as rendered SVG GEOMETRY, so a future pass that
 *     drops the glyph or reuses one reddens the gate rather than shipping.
 *
 * Every criterion is ASSERTED. `todo16-mobile.png` is evidence, never the check
 * — a screenshot diff cannot distinguish "clipped" from "restyled".
 *
 * THE OFFERING IS A PULL, so the roster alone cannot drive it. `status.wifi`
 * injects the interface, but `deriveWifiAdapterModeView` PREFERS the device's
 * own `wifi.getAdapterModes` answer — an RPC, which drop-and-inject cannot
 * reach — and the per-worker mock backend answers for its OWN radios, so every
 * injected fixture rendered as `station`. The harness therefore also answers
 * that ONE method in the page, the same `fakeAdapterModes` shape
 * `truthfulness.spec.ts` uses; asserting through the device-answered path is
 * what makes these the production renderings rather than the fallback's.
 *
 * PNG lands in apps/frontend/test-results (repo-local, gitignored).
 */

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../test-results");

/** The board capture the app's own `--mobile-dock-height` token was measured on. */
const NARROW = { width: 375, height: 812 } as const;

const LIVE_HOTSPOT = {
	name: "CeraLive-AP",
	available_channels: { auto: { name: "Automatic" } },
	channel: "auto",
};

function radio(over: Record<string, unknown>) {
	return {
		ifname: "wlan0",
		conn: "home-uuid",
		hw: "Wi-Fi adapter",
		saved: {},
		supports_hotspot: true,
		available: [
			{ active: true, ssid: "CERALIVE-5G", signal: 74, security: "WPA2", freq: 5180 },
		],
		...over,
	};
}

/** The device's own answer, in `wifiAdapterModeStatusSchema` shape. */
function adapterModes(device: string, mode: string, hybridAvailable: boolean) {
	return {
		[device]: {
			ifname: "wlan0",
			mode,
			options: [
				{ mode: "station", available: true },
				{ mode: "hotspot", available: true },
				hybridAvailable
					? { mode: "hybrid", available: true }
					: { mode: "hybrid", available: false, reason: "capability-absent" },
			],
		},
	};
}

/**
 * A DISTINCT device id per fixture, and that is load-bearing rather than tidy.
 * `WifiSection` re-pulls the offering only when the RADIO-ID SET changes, so
 * three fixtures under one id would leave the first pull's answer standing for
 * all three and the comparison test would assert one mode against itself.
 */
const FIXTURES = [
	{
		device: "0",
		mode: "station",
		iface: radio({ mode: "station", supports_ap_sta_concurrency: false }),
		modes: adapterModes("0", "station", false),
	},
	{
		device: "1",
		mode: "hotspot",
		iface: radio({ mode: "hotspot", hotspot: LIVE_HOTSPOT }),
		modes: adapterModes("1", "hotspot", false),
	},
	{
		device: "2",
		mode: "hybrid",
		iface: radio({
			mode: "station",
			supports_ap_sta_concurrency: true,
			hotspot: LIVE_HOTSPOT,
		}),
		modes: adapterModes("2", "hybrid", true),
	},
] as const;

function installWifiHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__wifiNarrow) return;
	const Real = w.WebSocket;
	w.__wifiNarrow = {
		socket: null,
		_seq: 0,
		adapterModes: undefined,
		emit(type: string, payload: unknown) {
			const s = w.__wifiNarrow.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `wifinarrow-emit-${++w.__wifiNarrow._seq}`,
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
			w.__wifiNarrow.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}
		// biome-ignore lint/suspicious/noExplicitAny: native send signature.
		send(data: any) {
			const modes = w.__wifiNarrow.adapterModes;
			if (modes !== undefined && typeof data === "string") {
				try {
					const frame = JSON.parse(data) as { id?: unknown; path?: unknown };
					const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
					if (rpc === "wifi.getAdapterModes" && frame.id !== undefined) {
						// Answered in the page and NOT forwarded: the per-worker backend
						// would otherwise answer for its own radios. Deferred a macrotask
						// so `send`'s caller has registered its pending request first.
						const reply = JSON.stringify({ id: frame.id, result: modes });
						setTimeout(() => {
							this.dispatchEvent(new MessageEvent("message", { data: reply }));
						}, 0);
						return;
					}
				} catch {
					/* non-RPC frame */
				}
			}
			this.__realSend(data);
		}
	}
	w.WebSocket = HookedWS;
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) =>
			(
				window as unknown as {
					__wifiNarrow: { emit(t: string, p: unknown): void };
				}
			).__wifiNarrow.emit(t, p),
		[type, payload] as const,
	);
}

/** Arm the in-page `wifi.getAdapterModes` answer BEFORE the roster is injected. */
function setAdapterModes(page: Page, modes: unknown): Promise<void> {
	return page.evaluate((m) => {
		(window as unknown as { __wifiNarrow: { adapterModes: unknown } }).__wifiNarrow.adapterModes =
			m;
	}, modes);
}

/**
 * The mode indicator's rendered SHAPE, in ONE round trip.
 *
 * One evaluate rather than a boundingBox per element: per-locator reads
 * interleave with layout, so a reflow between them can produce a verdict for a
 * layout that never existed on screen at once.
 */
async function probeMode(page: Page) {
	return page.evaluate(() => {
		// Scoped to the WiFi ROW, never to the document: a live hotspot also
		// renders a `wifi-mode-badge` in HotspotSection further down the page, and
		// a document-wide query would silently start measuring that one instead.
		const selector = document.querySelector(
			'[data-testid="wifi-mode-selector"]',
		) as HTMLElement | null;
		const row = (selector?.closest(".flex-wrap") ?? null) as HTMLElement | null;
		const badge = (row?.querySelector('[data-testid="wifi-mode-badge"]') ??
			null) as HTMLElement | null;
		const rungs = [
			...(row?.querySelectorAll<HTMLElement>('[data-testid^="wifi-mode-option-"]') ?? []),
		];

		const box = (el: HTMLElement | null) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
		};
		// A clipped element's own content is wider than the box painting it. `+1`
		// absorbs sub-pixel layout, never a truncated word.
		const clipped = (el: HTMLElement | null) =>
			el === null ? true : el.scrollWidth > el.clientWidth + 1;

		// Glyph GEOMETRY, not a class name: a CSS regression walks straight through
		// a class assertion, and two modes reusing one icon must be detectable.
		const glyphOf = (el: HTMLElement | null) =>
			el === null
				? ""
				: [...el.querySelectorAll("svg")]
						.flatMap((svg) => [...svg.querySelectorAll("path,circle,line,polyline,rect")])
						.map((n) => n.getAttribute("d") ?? n.outerHTML)
						.join("|");

		const overlaps = (a: DOMRect, b: DOMRect) =>
			a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

		const overlapping: string[] = [];
		for (let i = 0; i < rungs.length; i++) {
			for (let j = i + 1; j < rungs.length; j++) {
				const ri = rungs[i]!.getBoundingClientRect();
				const rj = rungs[j]!.getBoundingClientRect();
				if (overlaps(ri, rj)) {
					overlapping.push(
						`${rungs[i]!.dataset.testid} ∩ ${rungs[j]!.dataset.testid}`,
					);
				}
			}
		}

		const doc = document.documentElement;
		// WHICH element pushed the page sideways, not merely that something did —
		// a bare overflow number cannot distinguish this row from the fixed mobile
		// dock or an unrelated section, and would fail a WiFi test for either.
		const overflowSources: string[] = [];
		for (const el of document.querySelectorAll<HTMLElement>("body *")) {
			if (el.offsetParent === null) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0) continue;
			if (r.right > doc.clientWidth + 1 || r.left < -1) {
				overflowSources.push(
					`${el.dataset.testid ?? el.tagName}:${Math.round(r.left)}..${Math.round(r.right)}`,
				);
			}
		}

		return {
			overflowSources: overflowSources.slice(0, 12),
			rowOverflowPx: row
				? Math.max(0, (row as HTMLElement).scrollWidth - (row as HTMLElement).clientWidth)
				: -1,
			badgeMode: badge?.dataset.mode ?? null,
			badgeText: (badge?.textContent ?? "").trim(),
			badgeGlyph: glyphOf(badge),
			badgeBox: box(badge),
			badgeClipped: clipped(badge),
			selectorMode: selector?.dataset.mode ?? null,
			selectorBox: box(selector),
			rowBox: box(row as HTMLElement | null),
			rungs: rungs.map((r) => ({
				testid: r.dataset.testid ?? "",
				mode: r.dataset.mode ?? "",
				selected: r.dataset.selected ?? "",
				text: (r.textContent ?? "").trim(),
				clipped: clipped(r),
				box: box(r),
			})),
			rungsOverlapping: overlapping,
			documentOverflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth),
			viewportWidth: doc.clientWidth,
			openDialogs: document.querySelectorAll('[role="dialog"]').length,
		};
	});
}

test.describe("@visual Wi-Fi mode legibility at 375px", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"the viewport is set explicitly; running it in both projects only duplicates it",
		);
		await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
		await page.addInitScript(installWifiHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	for (const fixture of FIXTURES) {
		test(
			`a ${fixture.mode} radio names its mode on the row, with no dialog open`,
			{ tag: "@visual" },
			async ({ page }) => {
				await setAdapterModes(page, fixture.modes);
				await emit(page, "status", { wifi: { [fixture.device]: fixture.iface } });
				await expect(
					page.locator(
						`[data-testid="wifi-mode-selector"][data-mode="${fixture.mode}"]`,
					),
				).toBeVisible();

				const probe = await probeMode(page);

				expect(probe.viewportWidth).toBe(NARROW.width);
				// The criterion's own words: WITHOUT opening a dialog.
				expect(probe.openDialogs).toBe(0);

				expect(probe.badgeMode).toBe(fixture.mode);
				expect(probe.selectorMode).toBe(fixture.mode);
				expect(probe.badgeText.length).toBeGreaterThan(0);
				expect(probe.badgeText).not.toContain("network.wifiMode.");

				// Exactly one rung is chosen, and it is this mode's.
				const selected = probe.rungs.filter((r) => r.selected === "true");
				expect(selected).toHaveLength(1);
				expect(selected[0]?.mode).toBe(fixture.mode);
			},
		);
	}

	test(
		"the three modes differ in WORD and in GLYPH, not only in colour",
		{ tag: "@visual" },
		async ({ page }) => {
			const seen: { mode: string; text: string; glyph: string }[] = [];

			for (const fixture of FIXTURES) {
				await setAdapterModes(page, fixture.modes);
				await emit(page, "status", { wifi: { [fixture.device]: fixture.iface } });
				await expect(
					page.locator(
						`[data-testid="wifi-mode-selector"][data-mode="${fixture.mode}"]`,
					),
				).toBeVisible();
				const probe = await probeMode(page);
				seen.push({
					mode: fixture.mode,
					text: probe.badgeText,
					glyph: probe.badgeGlyph,
				});
			}

			expect(seen).toHaveLength(3);
			// Three distinct words…
			expect(new Set(seen.map((s) => s.text)).size).toBe(3);
			// …and three distinct shapes. `hotspot` and `hybrid` share a tone, so
			// without this the pair is separable by reading but not by glancing.
			expect(new Set(seen.map((s) => s.glyph)).size).toBe(3);
			for (const s of seen) expect(s.glyph.length).toBeGreaterThan(0);
		},
	);

	/**
	 * The plan's FAILURE-path QA, run as a standing gate rather than a one-off:
	 * hybrid is the widest of the three (the longest offering, the most live
	 * state), so if any mode truncates or collides at 375px it is this one.
	 */
	test(
		"the hybrid row's mode indicator is neither truncated nor overlapped",
		{ tag: "@visual" },
		async ({ page }) => {
			const hybrid = FIXTURES.find((f) => f.mode === "hybrid");
			if (hybrid === undefined) throw new Error("hybrid fixture missing");
			await setAdapterModes(page, hybrid.modes);
			await emit(page, "status", { wifi: { [hybrid.device]: hybrid.iface } });
			await expect(
				page.locator('[data-testid="wifi-mode-selector"][data-mode="hybrid"]'),
			).toBeVisible();

			const probe = await probeMode(page);

			expect(probe.badgeMode).toBe("hybrid");
			expect(probe.badgeClipped).toBe(false);
			expect(probe.rungs.filter((r) => r.clipped).map((r) => r.testid)).toEqual([]);
			expect(probe.rungsOverlapping).toEqual([]);
			// A rung that wrapped out of its own control, or a control that escaped
			// its row, is the collision this row's `flex-wrap` exists to avoid.
			for (const rung of probe.rungs) {
				expect(rung.box).not.toBeNull();
				expect(rung.box!.right).toBeLessThanOrEqual(probe.selectorBox!.right + 1);
				expect(rung.box!.x).toBeGreaterThanOrEqual(probe.selectorBox!.x - 1);
			}
			expect(probe.selectorBox!.right).toBeLessThanOrEqual(probe.rowBox!.right + 1);
			expect(probe.badgeBox!.right).toBeLessThanOrEqual(probe.rowBox!.right + 1);
			// The ROW is what this pass owns, so the row is what it asserts: nothing
			// inside it may scroll sideways, and no element anywhere may escape the
			// viewport by way of the WiFi section. The document-wide figure is
			// reported for diagnosis, never asserted — the page carries a fixed
			// mobile dock and unrelated sections this pass does not own.
			expect(probe.rowOverflowPx).toBe(0);
			expect(
				probe.overflowSources.filter((s) => /wifi/i.test(s)),
			).toEqual([]);

			fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
			await page
				.getByTestId("wifi-mode-selector")
				.locator("xpath=ancestor::section[1]")
				.screenshot({ path: path.join(EVIDENCE_DIR, "todo16-mobile.png") });
		},
	);
});

/**
 * Touch layout is applied at NAVIGATION, so it needs its own describe: setting
 * `data-layout-mode` after load measures the PRE-lift geometry, and navigating a
 * second time inside a test re-mounts the app underneath a roster that was
 * injected into the previous document.
 */
test.describe("@visual Wi-Fi mode legibility at 375px — touch layout", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"the viewport is set explicitly; running it in both projects only duplicates it",
		);
		await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
		await page.addInitScript(installWifiHarness);
		await page.goto("/?mode=touch");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	/**
	 * The 44px floor, measured rather than asserted in prose.
	 *
	 * This pass added NO new interactive control (the freshness marker is a
	 * `role="status"` span), so the whole claim is that the EXISTING
	 * `--touch-target-min` discipline still holds for every control the row
	 * carries. It is measured as the HIT AREA rather than the box: a switch is
	 * the one control that must NOT grow — `min-height` would stretch the painted
	 * track into a pill and strand the thumb — so `app.css` widens its `::after`
	 * overlay to the token instead, and a box-only probe would report the
	 * BondToggle as a failure while a finger reaches it fine.
	 */
	test(
		"every interactive control on the row clears 44px in touch layout",
		{ tag: "@visual" },
		async ({ page }) => {
			const hybrid = FIXTURES.find((f) => f.mode === "hybrid");
			if (hybrid === undefined) throw new Error("hybrid fixture missing");
			await setAdapterModes(page, hybrid.modes);
			await emit(page, "status", { wifi: { [hybrid.device]: hybrid.iface } });
			await expect(
				page.locator('[data-testid="wifi-mode-selector"][data-mode="hybrid"]'),
			).toBeVisible();

			const report = await page.evaluate(() => {
				const doc = document.documentElement;
				const row = document
					.querySelector('[data-testid="wifi-mode-selector"]')
					?.closest(".flex-wrap") as HTMLElement | null;
				if (!row) return { layoutMode: doc.dataset.layoutMode ?? null, token: "", short: [] };

				const token = getComputedStyle(doc).getPropertyValue("--touch-target-min").trim();
				const controls = [
					...row.querySelectorAll<HTMLElement>(
						'button, a[href], input, [role="switch"], [data-slot="switch"]',
					),
				];
				const short: { id: string; height: number }[] = [];
				for (const el of controls) {
					if (el.offsetParent === null) continue;
					const box = el.getBoundingClientRect();
					// The painted box OR the hit overlay, whichever reaches further.
					const after = getComputedStyle(el, "::after");
					const inset = Number.parseFloat(after.insetBlockStart);
					const hit = Number.isNaN(inset) ? box.height : box.height - 2 * inset;
					const height = Math.max(box.height, hit);
					if (height < 44) {
						short.push({
							id: el.dataset.testid ?? el.getAttribute("aria-label") ?? el.tagName,
							height: Math.round(height),
						});
					}
				}
				return { layoutMode: doc.dataset.layoutMode ?? null, token, short, count: controls.length };
			});

			// Non-vacuity: touch layout really is on, and the row really has controls.
			expect(report.layoutMode).toBe("touch");
			expect(report.token).toBe("44px");
			expect(report.count ?? 0).toBeGreaterThan(0);
			expect(report.short).toEqual([]);
		},
	);
});
