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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HealthIndicator, HealthRollup } from "$lib/stores/stream-health.svelte";
import type { HudState } from "$lib/types/hud";

import HudBar from "./HudBar.svelte";

type SocTelemetry = { temp: number | null; voltage: number | null; current: number | null; isStale: boolean };

const state = vi.hoisted(() => ({
	hud: undefined as HudState | undefined,
	health: "unknown" as HealthIndicator,
	rollup: null as HealthRollup | null,
	soc: { temp: null, voltage: null, current: null, isStale: false } as SocTelemetry,
}));

vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => state.hud,
	getSocTelemetry: () => state.soc,
}));

vi.mock("$lib/stores/stream-health.svelte", () => ({
	getStreamHealthState: () => state.health,
	getStreamHealthRollup: () => state.rollup,
}));

vi.mock("$lib/stores/buffering.svelte", () => ({ getBufferingState: () => null }));

vi.mock("$lib/stores/display-profile.svelte", () => ({
	getDisplayProfile: () => ({ theme: "lcd" }),
	getDisplayRefreshNonce: () => 0,
	prefersEinkTheme: () => false,
}));

const noop = vi.hoisted(
	() => async () => ({ default: (await import("../tests/fixtures/Noop.svelte")).default }),
);
vi.mock("$lib/components/custom/BondConstellation.svelte", noop);
vi.mock("$lib/components/custom/BufferingIndicator.svelte", noop);
vi.mock("$lib/components/custom/LinkIndicator.svelte", noop);
vi.mock("$lib/components/custom/Badge.svelte", noop);

function makeHud(overrides: Partial<HudState> = {}): HudState {
	return {
		isStreaming: false,
		isStreamingStale: false,
		bitrateKbps: null,
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
		lastUpdatedAt: { streaming: Date.now() - 60_000, sensors: Date.now() - 60_000, modems: null },
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
	// The strip badge is the only element carrying title="Bitrate".
	const el = document.querySelector<HTMLElement>('[title="Bitrate"]');
	if (!el) throw new Error("strip bitrate badge not rendered");
	return el;
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

describe("HudBar sheet — three explicit lifecycle states", () => {
	it("idle: subtitle data-state=idle, verdict says 'Idle', bitrate row is '—' (undimmed)", async () => {
		state.hud = makeHud({ isStreaming: false, bitrateKbps: null });
		render(HudBar);
		const dialog = await openSheet();

		expect(screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state")).toBe("idle");

		const verdict = within(dialog).getByTestId("stream-health-state");
		expect(verdict.textContent).toContain("Idle");
		// Exactly ONE status-wording node in the sheet.
		expect(within(dialog).getAllByText("Idle")).toHaveLength(1);

		const bitrateRow = within(dialog).getByText("Bitrate").closest("div");
		expect(bitrateRow?.textContent).toContain("—");
		expect(bitrateRow?.className).not.toContain("opacity-50");
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

		expect(screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state")).toBe("offline");

		const verdict = within(dialog).getByTestId("stream-health-state");
		expect(verdict.textContent).toContain("No signal");
		expect(within(dialog).getAllByText("No signal")).toHaveLength(1);
		expect(within(dialog).getByTestId("hud-last-seen")).toBeTruthy();

		const bitrateRow = within(dialog).getByText("Bitrate").closest("div");
		expect(bitrateRow?.textContent).toContain("—");
		expect(bitrateRow?.className).not.toContain("opacity-50");
	});

	it("live: subtitle data-state=live, verdict is the health rollup (not a lifecycle word)", async () => {
		state.hud = makeHud({ isStreaming: true, bitrateKbps: 6000 });
		state.health = "healthy";
		state.rollup = healthyRollup();
		render(HudBar);
		const dialog = await openSheet();

		expect(screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state")).toBe("live");

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
		const idleState = screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state");
		first.unmount();

		state.hud = makeHud({ isStreaming: true, isFullyStale: true });
		render(HudBar);
		await openSheet();
		const offlineState = screen.getByTestId("hud-sheet-subtitle").getAttribute("data-state");

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
		const dimmedWithNumber = Array.from(dialog.querySelectorAll<HTMLElement>(".opacity-50")).filter(
			(el) => /\d/.test(el.textContent ?? ""),
		);
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
