import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual NARROW-VIEWPORT legibility of the per-adapter Wi-Fi mode (todo 16).
 *
 * The acceptance criterion is a single sentence: at 375px, station / hotspot /
 * hybrid must be distinguishable WITHOUT opening a dialog.
 *
 * WHAT CARRIES THAT CRITERION MOVED (todo 32, cc23830), and the spec moved with
 * it. The three-rung selector no longer sits under the row: it lives behind the
 * row's "Mode" affordance (`open-wifi-mode`) in a bits-ui popover, which is
 * PORTALLED to `<body>` and renders nothing at all while closed. So the probe
 * anchors on that trigger — which IS in the row — instead of on the selector,
 * and the mode fact an operator reads at rest is `wifi-mode-badge`, still on the
 * row beside the radio's name.
 *
 * The criterion is not weakened by that move, it is narrowed to the thing that
 * actually satisfies it: a popover is not a dialog, and at rest there is no
 * popover, so `openDialogs === 0` still holds and is still asserted. The rungs
 * are asserted too, behind an explicit trigger click — that is what proves the
 * badge and the offering agree about which mode is current.
 *
 * Two things make this worth a browser rather than a jsdom test:
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
		held: undefined,
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
		hold(roster: unknown) {
			w.__wifiNarrow.held = roster;
			w.__wifiNarrow.emit("status", { wifi: roster });
		},
	};
	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__wifiNarrow.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			// A device `status.wifi` frame overwrites the whole roster, which would
			// swap the injected radio out from under an in-flight popover click.
			// Such a frame must not reach the app at all. Registered in the
			// constructor, so it precedes the app's own listener and
			// `stopImmediatePropagation` wins; the patched copy matches `held`, so
			// it re-enters once and passes through.
			this.addEventListener("message", (ev: MessageEvent) => {
				const held = w.__wifiNarrow.held;
				if (held === undefined || typeof ev.data !== "string") return;
				let parsed: { status?: Record<string, unknown> };
				try {
					parsed = JSON.parse(ev.data);
				} catch {
					return;
				}
				const status = parsed?.status;
				if (!status || status.wifi === undefined) return;
				if (JSON.stringify(status.wifi) === JSON.stringify(held)) return;
				ev.stopImmediatePropagation();
				this.dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({ ...parsed, status: { ...status, wifi: held } }),
					}),
				);
			});
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

/** Publish a roster AND keep it published against the device's own broadcasts. */
function hold(page: Page, roster: unknown): Promise<void> {
	return page.evaluate(
		(r) =>
			(window as unknown as { __wifiNarrow: { hold(r: unknown): void } }).__wifiNarrow.hold(r),
		roster,
	);
}

/** Reveal the three-rung selector the row demoted behind its "Mode" affordance. */
async function openModePopover(page: Page): Promise<void> {
	await page.getByTestId("open-wifi-mode").first().click();
	await expect(page.getByTestId("wifi-mode-selector").first()).toBeVisible();
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
		// Anchored on the row's own "Mode" affordance, never on the document: a
		// live hotspot also renders a `wifi-mode-badge` in HotspotSection further
		// down the page, and a document-wide badge query would silently start
		// measuring that one instead.
		const trigger = document.querySelector(
			'[data-testid="open-wifi-mode"]',
		) as HTMLElement | null;
		// The row is reached by its OWN handle, not by climbing to the nearest
		// `.flex-wrap`: the action group the trigger sits in wraps as well, so a
		// class-shaped anchor stops one box short and reports that group's
		// overflow — always 0 — instead of the row's.
		const row = (trigger?.closest('[data-testid="wifi-row"]') ??
			null) as HTMLElement | null;
		const badge = (row?.querySelector('[data-testid="wifi-mode-badge"]') ??
			null) as HTMLElement | null;
		// The selector is PORTALLED out of the row while open and absent while
		// closed, so it is reached from the document and its rungs from it.
		const selector = document.querySelector(
			'[data-testid="wifi-mode-selector"]',
		) as HTMLElement | null;
		const rungs = [
			...(selector?.querySelectorAll<HTMLElement>('[data-testid^="wifi-mode-option-"]') ?? []),
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
			triggerPresent: trigger !== null,
			triggerBox: box(trigger),
			triggerClipped: clipped(trigger),
			selectorPresent: selector !== null,
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
				await hold(page, { [fixture.device]: fixture.iface });
				await expect(
					page.locator(`[data-testid="wifi-mode-badge"][data-mode="${fixture.mode}"]`).first(),
				).toBeVisible();

				const atRest = await probeMode(page);

				expect(atRest.viewportWidth).toBe(NARROW.width);
				// The criterion's own words: WITHOUT opening a dialog.
				expect(atRest.openDialogs).toBe(0);
				// …and the selector really is behind the affordance, not merely
				// unopened: a closed bits-ui popover renders no content at all.
				expect(atRest.selectorPresent).toBe(false);
				expect(atRest.triggerPresent).toBe(true);

				expect(atRest.badgeMode).toBe(fixture.mode);
				expect(atRest.badgeText.length).toBeGreaterThan(0);
				expect(atRest.badgeText).not.toContain("network.wifiMode.");

				// The row's badge and the offering behind it must name the SAME
				// mode, or the fact an operator reads at rest is not the one the
				// control would act on.
				await openModePopover(page);
				const opened = await probeMode(page);
				expect(opened.selectorMode).toBe(fixture.mode);

				// Exactly one rung is chosen, and it is this mode's.
				const selected = opened.rungs.filter((r) => r.selected === "true");
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
				await hold(page, { [fixture.device]: fixture.iface });
				await expect(
					page.locator(`[data-testid="wifi-mode-badge"][data-mode="${fixture.mode}"]`).first(),
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
			await hold(page, { [hybrid.device]: hybrid.iface });
			await expect(
				page.locator('[data-testid="wifi-mode-badge"][data-mode="hybrid"]').first(),
			).toBeVisible();

			// AT REST the row carries the badge and the affordance, and both must
			// fit it. The rungs are measured separately, below, because they no
			// longer live in this box.
			const atRest = await probeMode(page);
			expect(atRest.badgeMode).toBe("hybrid");
			expect(atRest.badgeClipped).toBe(false);
			expect(atRest.triggerClipped).toBe(false);
			expect(atRest.badgeBox!.right).toBeLessThanOrEqual(atRest.rowBox!.right + 1);
			expect(atRest.triggerBox!.right).toBeLessThanOrEqual(atRest.rowBox!.right + 1);

			await openModePopover(page);
			const probe = await probeMode(page);

			expect(probe.rungs).toHaveLength(3);
			expect(probe.rungs.filter((r) => r.clipped).map((r) => r.testid)).toEqual([]);
			expect(probe.rungsOverlapping).toEqual([]);
			// A rung that wrapped out of its own control is the collision the
			// selector's `flex-wrap` exists to avoid. The selector is PORTALLED, so
			// it is bounded by the viewport rather than by the row.
			for (const rung of probe.rungs) {
				expect(rung.box).not.toBeNull();
				expect(rung.box!.right).toBeLessThanOrEqual(probe.selectorBox!.right + 1);
				expect(rung.box!.x).toBeGreaterThanOrEqual(probe.selectorBox!.x - 1);
			}
			expect(probe.selectorBox!.right).toBeLessThanOrEqual(probe.viewportWidth + 1);
			expect(probe.selectorBox!.x).toBeGreaterThanOrEqual(-1);
			// The ROW is what this pass owns, so the row is what it asserts: nothing
			// inside it may scroll sideways, and no element anywhere may escape the
			// viewport by way of the WiFi section. The document-wide figure is
			// reported for diagnosis, never asserted — the page carries a fixed
			// mobile dock and unrelated sections this pass does not own.
			expect(probe.rowOverflowPx).toBe(0);
			expect(
				probe.overflowSources.filter((s) => /wifi/i.test(s)),
			).toEqual([]);

			// Anchored on the trigger, not the selector: the selector is portalled
			// to <body>, whose nearest ancestor section is not the WiFi card.
			fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
			await page
				.getByTestId("open-wifi-mode")
				.first()
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
	 * The claim is that the `--touch-target-min` discipline holds for every
	 * control an operator can reach for the mode — which since todo 32 spans TWO
	 * surfaces: the row (whose controls now include the `open-wifi-mode`
	 * affordance) and the popover the affordance reveals (which is where the
	 * three rungs went). Measuring only the row would silently stop covering the
	 * rungs this test was originally written for.
	 *
	 * It is measured as the HIT AREA rather than the box: a switch is
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
			await hold(page, { [hybrid.device]: hybrid.iface });
			await expect(
				page.locator('[data-testid="wifi-mode-badge"][data-mode="hybrid"]').first(),
			).toBeVisible();

			const measure = (scope: "row" | "selector") =>
				page.evaluate((which) => {
					const doc = document.documentElement;
					const root =
						which === "row"
							? ((document
									.querySelector('[data-testid="open-wifi-mode"]')
									?.closest('[data-testid="wifi-row"]') ?? null) as HTMLElement | null)
							: (document.querySelector('[data-testid="wifi-mode-selector"]') as
									| HTMLElement
									| null);
					if (!root)
						return { layoutMode: doc.dataset.layoutMode ?? null, token: "", short: [], count: 0 };

					const token = getComputedStyle(doc).getPropertyValue("--touch-target-min").trim();
					const controls = [
						...root.querySelectorAll<HTMLElement>(
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
					return {
						layoutMode: doc.dataset.layoutMode ?? null,
						token,
						short,
						count: controls.length,
					};
				}, scope);

			const row = await measure("row");
			await openModePopover(page);
			const selector = await measure("selector");

			// Non-vacuity: touch layout really is on, and BOTH surfaces really
			// carry controls — the rungs are only reachable once opened.
			expect(row.layoutMode).toBe("touch");
			expect(row.token).toBe("44px");
			expect(row.count).toBeGreaterThan(0);
			expect(selector.count).toBeGreaterThan(0);
			expect(row.short).toEqual([]);
			expect(selector.short).toEqual([]);
		},
	);
});
