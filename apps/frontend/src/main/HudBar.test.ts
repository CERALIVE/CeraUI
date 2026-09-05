// @vitest-environment jsdom
/**
 * HudBar — dead-state honesty + one verdict line (Task 8, Live-Data Discipline).
 *
 * Locks the three explicit sheet lifecycle states (live / idle / offline):
 * bitrate renders "—" (never a dimmed stale number) outside `live`; idle vs
 * offline expose distinct `data-state`; the sheet carries exactly ONE
 * status-wording node (the consolidated verdict line), never the deleted
 * standalone Status row or the old lifecycle wording in the sheet description.
 */
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	HealthIndicator,
	HealthRollup,
} from "$lib/stores/stream-health.svelte";
import type { HudState } from "$lib/types/hud";

import HudBar from "./HudBar.svelte";

type SocTelemetry = {
	temp: number | null;
	voltage: number | null;
	current: number | null;
	isStale: boolean;
};

const state = vi.hoisted(() => ({
	hud: undefined as HudState | undefined,
	health: "unknown" as HealthIndicator,
	rollup: null as HealthRollup | null,
	soc: {
		temp: null,
		voltage: null,
		current: null,
		isStale: false,
	} as SocTelemetry,
}));

vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => state.hud,
	getSocTelemetry: () => state.soc,
}));

vi.mock("$lib/stores/stream-health.svelte", () => ({
	getStreamHealthState: () => state.health,
	getStreamHealthRollup: () => state.rollup,
}));

vi.mock("$lib/stores/buffering.svelte", () => ({
	getBufferingState: () => null,
}));

vi.mock("$lib/stores/display-profile.svelte", () => ({
	getDisplayProfile: () => ({ theme: "lcd" }),
	getDisplayRefreshNonce: () => 0,
	prefersEinkTheme: () => false,
}));

const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/BondConstellation.svelte", noop);
vi.mock("$lib/components/custom/BufferingIndicator.svelte", noop);
vi.mock("$lib/components/custom/LinkIndicator.svelte", noop);
vi.mock("$lib/components/custom/Badge.svelte", noop);

function makeHud(overrides: Partial<HudState> = {}): HudState {
	return {
		isStreaming: false,
		isStreamingStale: false,
		bitrateKbps: null,
		measuredBitrateKbps: null,
		isBitrateStale: false,
		links: [],
		staleInterfaces: new Set<string>(),
		temperature: null,
		voltage: null,
		current: null,
		isSensorsStale: false,
		isConnected: true,
		isFullyStale: false,
		isUpdating: false,
		lastUpdatedAt: {
			streaming: Date.now() - 60_000,
			sensors: Date.now() - 60_000,
			modems: null,
		},
		...overrides,
	};
}

function healthyRollup(): HealthRollup {
	return {
		state: "healthy",
		process: { alive: true },
		frames: { advancing: true, count: 100 },
		srt: { reconnecting: false, reconnectCount: 0 },
		bond: { linkCount: 2, activeLinks: 2 },
	};
}

async function openSheet(): Promise<HTMLElement> {
	const trigger = document.querySelector<HTMLElement>("[data-hud-region]");
	if (!trigger) throw new Error("HUD trigger not rendered");
	await fireEvent.click(trigger);
	return waitFor(() => screen.getByRole("dialog"));
}

function stripBitrate(): HTMLElement {
	// Keyed on the testid, not on a title/label — the heading now switches
	// between "Bitrate" and "Target" depending on whether the figure is measured.
	const el = document.querySelector<HTMLElement>('[data-testid="hud-bitrate"]');
	if (!el) throw new Error("strip bitrate badge not rendered");
	return el;
}

function compactStrip(): HTMLElement {
	const el = document.querySelector<HTMLElement>("[data-hud-region]");
	if (!el) throw new Error("HUD compact strip not rendered");
	return el;
}

/**
 * Every `hud-`-prefixed testid the COMPACT strip is allowed to carry.
 *
 * `AGENTS.md` → "HUD 4-fact scope": the strip states exactly FOUR facts — the
 * lifecycle badge, the health verdict, the bitrate, and ONE temperature chip.
 * Only the bitrate fact is `hud-`-keyed, and these three ids are all of it (the
 * headline plus its two qualifiers). Growing this list is a documented UX
 * regression, not a routine update — a budget is undone by good commits one at
 * a time unless something counts them.
 */
const STRIP_HUD_TESTIDS = [
	"hud-bitrate",
	"hud-bitrate-limit",
	"hud-bitrate-target",
] as const;

function stripHudTestIds(): string[] {
	return [
		...compactStrip().querySelectorAll<HTMLElement>('[data-testid^="hud-"]'),
	]
		.map((el) => el.getAttribute("data-testid") ?? "")
		.sort();
}

function throttledLiveHud(): HudState {
	return makeHud({
		isStreaming: true,
		bitrateKbps: 4100,
		measuredBitrateKbps: 3200,
		bitrateCeilingKbps: 6000,
		isBitrateBelowCeiling: true,
	});
}

function degradedRollup(detail = "No frames advancing"): HealthRollup {
	return {
		state: "degraded",
		reason: { component: "frames", detail },
		process: { alive: true },
		frames: { advancing: false, count: 0 },
		srt: { reconnecting: false, reconnectCount: 0 },
		bond: { linkCount: 2, activeLinks: 2 },
	};
}

function classesOf(el: HTMLElement): string[] {
	return el.className.split(/\s+/).filter(Boolean);
}

beforeEach(() => {
	state.hud = makeHud();
	state.health = "unknown";
	state.rollup = null;
	state.soc = { temp: null, voltage: null, current: null, isStale: false };
});

describe("HudBar bitrate honesty — absence renders as absence", () => {
	it("idle (not streaming): strip bitrate is '—', never a dimmed number", () => {
		state.hud = makeHud({ isStreaming: false, bitrateKbps: null });
		render(HudBar);
		const badge = stripBitrate();
		expect(badge.textContent?.trim()).toBe("—");
		expect(badge.className).not.toContain("opacity-50");
	});

	it("offline (streaming but fully stale): strip bitrate is '—', NOT a dimmed stale number", () => {
		// bitrateKbps still carries the last-known value; the render must still be "—".
		state.hud = makeHud({
			isStreaming: true,
			isFullyStale: true,
			bitrateKbps: 6000,
			isBitrateStale: true,
		});
		render(HudBar);
		const badge = stripBitrate();
		expect(badge.textContent?.trim()).toBe("—");
		expect(badge.className).not.toContain("opacity-50");
	});

	it("live: strip bitrate shows the real value, not '—'", () => {
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 6000 });
		render(HudBar);
		expect(stripBitrate().textContent?.trim()).not.toBe("—");
	});
});

// A board session held the engine's setpoint at a steady 4.1 Mbps while zero
// frames reached the network: the number an operator reads as "the bitrate"
// could not distinguish streaming from streaming nothing. The measured bond
// throughput can, so it takes the headline and the setpoint is labelled Target.
describe("HudBar bitrate — measured takes the headline, setpoint is 'Target'", () => {
	it("headlines the MEASURED figure and demotes the setpoint to a Target chip", () => {
		state.hud = makeHud({
			isStreaming: true,
			bitrateKbps: 4100,
			measuredBitrateKbps: 3200,
		});
		render(HudBar);

		const badge = stripBitrate();
		expect(badge.getAttribute("data-measured")).toBe("true");
		expect(badge.textContent).toContain("3.2");
		expect(badge.textContent).not.toContain("4.1 Mbps Mbps");

		const target = screen.getByTestId("hud-bitrate-target");
		expect(target.textContent).toContain("Target");
		expect(target.textContent).toContain("4.1");
	});

	it("relabels the heading 'Target' when no measurement is available", async () => {
		state.hud = makeHud({
			isStreaming: true,
			bitrateKbps: 4100,
			measuredBitrateKbps: null,
		});
		render(HudBar);

		expect(stripBitrate().getAttribute("data-measured")).toBeNull();
		expect(screen.queryByTestId("hud-bitrate-target")).toBeNull();

		const dialog = await openSheet();
		const row = within(dialog).getByTestId("hud-bitrate-row");
		expect(row.textContent).toContain("Target");
		expect(row.textContent).not.toContain("Bitrate");
	});

	it("a measured ZERO is reported as zero, never masked by the setpoint", () => {
		// The exact board fixture: setpoint steady at 4100, nothing on the wire.
		state.hud = makeHud({
			isStreaming: true,
			bitrateKbps: 4100,
			measuredBitrateKbps: 0,
		});
		render(HudBar);

		const badge = stripBitrate();
		expect(badge.getAttribute("data-measured")).toBe("true");
		// The HEADLINE leads with the measurement; 4100 may only appear after it,
		// inside the Target chip.
		expect(badge.textContent?.trim().startsWith("0")).toBe(true);
		expect(screen.getByTestId("hud-bitrate-target").textContent).toContain(
			"4.1",
		);
	});

	// The visual heading may read "Target", but a bare "Target: 4.1 Mbps" tells a
	// screen-reader user nothing about WHAT is targeted — and two e2e specs pin
	// the chip by its accessible name (`getByRole('img', {name: /bitrate/i})`).
	// The name therefore always leads with "Bitrate" and carries the distinction
	// as a qualifier.
	it("keeps 'Bitrate' in the accessible name even when the heading says Target", () => {
		state.hud = makeHud({
			isStreaming: true,
			bitrateKbps: 4100,
			measuredBitrateKbps: null,
		});
		render(HudBar);

		const label = stripBitrate().getAttribute("aria-label") ?? "";
		expect(label).toMatch(/^Bitrate:/);
		expect(label).toContain("Target");
	});

	it("does not call an absent value a Target", () => {
		state.hud = makeHud({ isStreaming: false });
		render(HudBar);

		const label = stripBitrate().getAttribute("aria-label") ?? "";
		expect(label).toMatch(/^Bitrate:/);
		expect(label).not.toContain("Target");
	});

	it("clears the measured figure on stop — never a rate from the last session", () => {
		state.hud = makeHud({
			isStreaming: false,
			bitrateKbps: null,
			measuredBitrateKbps: null,
		});
		render(HudBar);

		expect(stripBitrate().textContent?.trim()).toBe("—");
		expect(screen.queryByTestId("hud-bitrate-target")).toBeNull();
	});
});

describe("HudBar sheet — three explicit lifecycle states", () => {
	it("idle: subtitle data-state=idle, verdict says 'Idle', bitrate row is '—' (undimmed)", async () => {
		state.hud = makeHud({ isStreaming: false, bitrateKbps: null });
		render(HudBar);
		const dialog = await openSheet();

		expect(
			screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state"),
		).toBe("idle");

		const verdict = within(dialog).getByTestId("stream-health-state");
		expect(verdict.textContent).toContain("Idle");
		// Exactly ONE status-wording node in the sheet.
		expect(within(dialog).getAllByText("Idle")).toHaveLength(1);

		const bitrateRow = within(dialog).getByTestId("hud-bitrate-row");
		expect(bitrateRow.textContent).toContain("—");
		expect(bitrateRow.className).not.toContain("opacity-50");
	});

	it("offline: subtitle data-state=offline, verdict says 'No signal' + last seen line", async () => {
		state.hud = makeHud({
			isStreaming: true,
			isFullyStale: true,
			bitrateKbps: 6000,
			isBitrateStale: true,
		});
		render(HudBar);
		const dialog = await openSheet();

		expect(
			screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state"),
		).toBe("offline");

		const verdict = within(dialog).getByTestId("stream-health-state");
		expect(verdict.textContent).toContain("No signal");
		expect(within(dialog).getAllByText("No signal")).toHaveLength(1);
		expect(within(dialog).getByTestId("hud-last-seen")).toBeTruthy();

		const bitrateRow = within(dialog).getByTestId("hud-bitrate-row");
		expect(bitrateRow.textContent).toContain("—");
		expect(bitrateRow.className).not.toContain("opacity-50");
	});

	it("live: subtitle data-state=live, verdict is the health rollup (not a lifecycle word)", async () => {
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 6000 });
		state.health = "healthy";
		state.rollup = healthyRollup();
		render(HudBar);
		const dialog = await openSheet();

		expect(
			screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state"),
		).toBe("live");

		const verdict = within(dialog).getByTestId("stream-health-state");
		expect(verdict.textContent).toContain("Healthy");
		expect(verdict.textContent).not.toContain("Idle");
		expect(verdict.textContent).not.toContain("No signal");
		// The health breakdown (process/frames/SRT/bond) is present while live.
		expect(within(dialog).getByTestId("stream-health-rollup")).toBeTruthy();
	});

	it("idle vs offline render DISTINCT sheet data-state attrs", async () => {
		state.hud = makeHud({ isStreaming: false });
		const first = render(HudBar);
		await openSheet();
		const idleState = screen
			.getByTestId("hud-sheet-subtitle")
			.getAttribute("data-state");
		first.unmount();

		state.hud = makeHud({ isStreaming: true, isFullyStale: true });
		render(HudBar);
		await openSheet();
		const offlineState = screen
			.getByTestId("hud-sheet-subtitle")
			.getAttribute("data-state");

		expect(idleState).toBe("idle");
		expect(offlineState).toBe("offline");
		expect(idleState).not.toBe(offlineState);
	});

	it("offline sheet has ZERO dimmed bitrate elements (no old opacity-50 stale-value pattern)", async () => {
		state.hud = makeHud({
			isStreaming: true,
			isFullyStale: true,
			bitrateKbps: 6000,
			isBitrateStale: true,
		});
		render(HudBar);
		const dialog = await openSheet();
		const dimmedWithNumber = Array.from(
			dialog.querySelectorAll<HTMLElement>(".opacity-50"),
		).filter((el) => /\d/.test(el.textContent ?? ""));
		expect(dimmedWithNumber).toHaveLength(0);
	});
});

describe("HudBar sheet reflow (Task 18) — one-glance order + trimmed compact strip", () => {
	it("bond constellation is ABSENT when idle, PRESENT when live", async () => {
		state.hud = makeHud({ isStreaming: false });
		const first = render(HudBar);
		const idleDialog = await openSheet();
		expect(within(idleDialog).queryByTestId("hud-constellation")).toBeNull();
		first.unmount();

		state.hud = makeHud({ isStreaming: true, bitrateKbps: 6000 });
		render(HudBar);
		const liveDialog = await openSheet();
		expect(within(liveDialog).getByTestId("hud-constellation")).toBeTruthy();
	});

	it("sheet exposes EXACTLY ONE inline sensors line (not three bordered rows)", async () => {
		state.hud = makeHud({ temperature: 42.5, voltage: 5.1, current: 1.5 });
		render(HudBar);
		const dialog = await openSheet();
		expect(within(dialog).getAllByTestId("hud-sensors-line")).toHaveLength(1);
	});

	it("voltage/current live in the SHEET only — the compact strip carries neither", () => {
		state.soc = { temp: 42, voltage: 5, current: 1, isStale: false };
		state.hud = makeHud({ temperature: 42, voltage: 5, current: 1 });
		render(HudBar);

		const strip = document.querySelector<HTMLElement>("[data-hud-region]");
		if (!strip) throw new Error("HUD strip not rendered");
		expect(strip.querySelector('[title="Voltage"]')).toBeNull();
		expect(strip.querySelector('[title="Current"]')).toBeNull();
		expect(strip.querySelector('[title="Temperature"]')).not.toBeNull();
	});
});

describe("HudBar health honesty (Todo 19) — idle dot + tri-state tiles", () => {
	function idleRollup(): HealthRollup {
		return {
			state: "idle",
			process: { alive: null },
			frames: { advancing: null, count: null },
			srt: { reconnecting: null, reconnectCount: 0 },
			bond: { linkCount: 0, activeLinks: 0 },
		};
	}

	it("idle renders a calm idle dot (data-state=idle), never the dead cross", () => {
		state.health = "idle";
		state.hud = makeHud({ isStreaming: false });
		render(HudBar);
		const dot = screen.getByTestId("stream-health");
		expect(dot.getAttribute("data-state")).toBe("idle");
		expect(dot.getAttribute("data-state")).not.toBe("dead");
		expect(dot.textContent).toContain("Idle");
	});

	it("idle rollup tiles render the unknown tri-state, not 'stalled'/'not running'", async () => {
		state.health = "idle";
		state.rollup = idleRollup();
		state.hud = makeHud({ isStreaming: true });
		render(HudBar);
		const dialog = await openSheet();
		expect(
			within(dialog).getByTestId("health-process").getAttribute("data-state"),
		).toBe("unknown");
		expect(
			within(dialog).getByTestId("health-frames").getAttribute("data-state"),
		).toBe("unknown");
		expect(
			within(dialog).getByTestId("health-srt").getAttribute("data-state"),
		).toBe("unknown");
	});

	it("srt tile renders each tri-state input distinctly (false=ok, true=bad, null=unknown)", async () => {
		const cases: Array<[boolean | null, string]> = [
			[false, "ok"],
			[true, "bad"],
			[null, "unknown"],
		];
		for (const [reconnecting, expected] of cases) {
			state.health = "healthy";
			state.rollup = {
				...healthyRollup(),
				srt: { reconnecting, reconnectCount: 0 },
			};
			state.hud = makeHud({ isStreaming: true, bitrateKbps: 6000 });
			const view = render(HudBar);
			const dialog = await openSheet();
			expect(
				within(dialog).getByTestId("health-srt").getAttribute("data-state"),
			).toBe(expected);
			view.unmount();
		}
	});
});

// ── design-pass 26 ───────────────────────────────────────────────────────────
// The compact strip's three refinements: a middot instead of a slash between
// two bitrates, the health reason readable at EVERY width, and the four-fact
// budget pinned by a gate rather than by a paragraph.

describe("HudBar strip — the ceiling is separated by a middot, never a slash", () => {
	it("renders the configured ceiling with no '/' anywhere in the chip", () => {
		state.hud = throttledLiveHud();
		render(HudBar);

		const limit = screen.getByTestId("hud-bitrate-limit");
		expect(limit.textContent).toContain("6");
		expect(limit.textContent).not.toContain("/");
		expect(stripBitrate().textContent).not.toContain("/");
	});

	it("separates it with an aria-hidden middot, so the ceiling is not read twice", () => {
		state.hud = throttledLiveHud();
		render(HudBar);

		const separator =
			screen.getByTestId("hud-bitrate-limit").previousElementSibling;
		expect(separator?.textContent?.trim()).toBe("·");
		expect(separator?.getAttribute("aria-hidden")).toBe("true");
	});

	it("keeps the ceiling NAMED in the accessible name, so the middot costs no meaning", () => {
		state.hud = throttledLiveHud();
		render(HudBar);

		const label = stripBitrate().getAttribute("aria-label") ?? "";
		expect(label).toContain("Configured limit");
		expect(label).toContain("Target");
	});
});

describe("HudBar strip — the health reason is visible at EVERY width", () => {
	it("carries no `hidden` class, so a 375px-class render still states the cause", () => {
		state.health = "degraded";
		state.rollup = degradedRollup();
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 4100 });
		render(HudBar);

		const reason = screen.getByTestId("stream-health-reason");
		expect(reason.textContent).toContain("No frames advancing");

		const classes = classesOf(reason);
		expect(classes).not.toContain("hidden");
		// The retired mechanism: `hidden sm:inline` withheld the cause below `sm`,
		// leaving a verdict a narrow-viewport operator could not explain.
		expect(classes).not.toContain("sm:inline");
	});

	it("stacks it UNDER the badge below `sm` and returns it inline from `sm` up", () => {
		state.health = "degraded";
		state.rollup = degradedRollup();
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 4100 });
		render(HudBar);

		const cluster = screen.getByTestId("stream-health-reason").parentElement;
		if (cluster === null)
			throw new Error("reason is not inside the lead cluster");

		const clusterClasses = classesOf(cluster);
		expect(clusterClasses).toContain("flex-col");
		expect(clusterClasses).toContain("sm:flex-row");
		// The lifecycle badge and the health verdict share the row ABOVE it.
		expect(cluster.contains(screen.getByTestId("stream-health"))).toBe(true);
	});

	it("keeps the second line inside the strip's own box — the dock never grows", () => {
		state.health = "degraded";
		state.rollup = degradedRollup();
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 4100 });
		render(HudBar);

		// jsdom lays nothing out, so the h-12 ceiling is asserted as the MECHANISM
		// that keeps `--mobile-dock-height` honest; the rendered geometry is
		// measured in tests/e2e/visual/hud-sheet.visual.spec.ts at 375x812.
		expect(classesOf(compactStrip())).toContain("h-12");
	});

	it("a healthy rollup states no cause at all — absence renders as absence", () => {
		state.health = "healthy";
		state.rollup = healthyRollup();
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 4100 });
		render(HudBar);

		expect(screen.queryByTestId("stream-health-reason")).toBeNull();
	});
});

describe("HudBar strip — the FOUR-fact budget is locked", () => {
	it("idle: the bitrate is the only hud- fact on the strip", () => {
		state.hud = makeHud({ isStreaming: false });
		render(HudBar);

		expect(stripHudTestIds()).toEqual(["hud-bitrate"]);
	});

	it("live, measured and throttled: exactly the documented bitrate qualifiers, no fifth", () => {
		state.hud = throttledLiveHud();
		render(HudBar);

		expect(stripHudTestIds()).toEqual([...STRIP_HUD_TESTIDS]);
	});

	it("the four facts are the badge, the verdict, the bitrate and ONE temp chip", () => {
		state.soc = { temp: 42, voltage: 5, current: 1, isStale: false };
		state.hud = throttledLiveHud();
		render(HudBar);

		const strip = compactStrip();
		// The FACT is the `role="img"` chip; the inner value node repeats the title
		// as its own tooltip, so a bare title query counts one chip twice.
		expect(
			strip.querySelectorAll('[role="img"][title="Temperature"]'),
		).toHaveLength(1);
		expect(strip.querySelector('[data-testid="stream-health"]')).not.toBeNull();
		expect(strip.querySelector('[data-testid="hud-bitrate"]')).not.toBeNull();
		// Never the server target, never the encoder — both have richer owners
		// elsewhere and either one would be the fifth fact. `hud-bitrate-target`
		// is a qualifier ON the bitrate fact, not a target of its own.
		expect(
			[...strip.querySelectorAll<HTMLElement>("[data-testid]")]
				.map((el) => el.getAttribute("data-testid") ?? "")
				.filter((id) => /encoder|server/.test(id)),
		).toEqual([]);
	});

	it("the two live regions sit OUTSIDE the strip, so they cannot pad the budget", () => {
		state.hud = makeHud({ isStreaming: false });
		render(HudBar);

		const strip = compactStrip();
		for (const id of ["hud-telemetry-status", "hud-transition-status"]) {
			const region = screen.getByTestId(id);
			expect(region).toBeTruthy();
			expect(strip.contains(region)).toBe(false);
		}
	});
});
