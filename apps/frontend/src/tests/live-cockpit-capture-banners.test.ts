// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "./helpers/catalog";

vi.mock("$lib/components/custom/IngestStats.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/BitrateAdjuster.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveSourceSwitch.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveSummaryStrip.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/StreamControlButton.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/StreamTelemetryStrip.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));

import LiveCockpit from "../main/live/LiveCockpit.svelte";

// biome-ignore lint/suspicious/noExplicitAny: minimal props shim for a presentational cockpit render
function baseProps(overrides: Record<string, any>): any {
	return {
		liveSummary: { source: "HDMI", parts: [] },
		bitrate: "6.0",
		bitrateDraft: 6000,
		bitrateLabel: "6.0 Mbps",
		bitrateMin: 500,
		bitrateMax: 12000,
		sliderMin: 500,
		sliderMax: 12000,
		step: 100,
		onStep: () => {},
		onSliderChange: () => {},
		onSliderCommit: () => {},
		telemetry: null,
		isStreaming: true,
		optimismState: "streaming",
		onStop: () => {},
		...overrides,
	};
}

const capture = (id: string, lost = false) => ({
	id,
	origin: "capture" as const,
	kind: "hdmi" as const,
	displayName: id,
	lost,
	available: true,
	modes: [],
	audioKind: "none" as const,
});

const staleLink = (conn_id: string) => ({
	conn_id,
	iface: `eth${conn_id}`,
	rtt_ms: 0,
	nak_count: 0,
	weight_percent: 100,
	stale: true,
});

const captureBlock = (overrides: Record<string, unknown> = {}) => ({
	state: "normal",
	live_inputs: ["cam0"],
	degraded_inputs: [],
	failover_rate_policy: "retime",
	...overrides,
});

function activeEncode(
	activeInput: string,
	capture: Record<string, unknown>,
	switchTargets: Record<string, unknown>[] = [
		{ input_id: "cam0", kind: "capture" },
		{ input_id: "cam1", kind: "capture" },
	],
) {
	return {
		active_input: activeInput,
		codec: "h265",
		resolution: "1920x1080",
		framerate: 30,
		switch_targets: switchTargets,
		capture,
	};
}

const twoCameras = {
	config: { source: "cam0" },
	sources: { hardware: [], sources: [capture("cam0"), capture("cam1")] },
};

const CAPTURE_BANNERS = [
	"capture-standby-banner",
	"composition-suspended-banner",
	"passthrough-suspended-banner",
	"rate-adapted-banner",
] as const;

afterEach(() => cleanup());

describe("LiveCockpit — capture standby band", () => {
	it("shows the standby band when the engine reports capture.state standby", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				sources: {
					hardware: [],
					sources: [capture("cam0", true), capture("cam1", true)],
				},
				activeEncode: activeEncode(
					"standby",
					captureBlock({ state: "standby" }),
					[],
				),
			}),
		);
		await tick();
		const band = getByTestId("capture-standby-banner");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain(en.live.capture.standbyTitle);
		expect(band.textContent).toContain(en.live.capture.standbyBody);
	});

	it("HIDES the source-lost and video-signal-lost bands while on standby — one outage, one sentence", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				videoSignalLost: true,
				sources: {
					hardware: [],
					sources: [capture("cam0", true), capture("cam1", true)],
				},
				activeEncode: activeEncode(
					"standby",
					captureBlock({ state: "standby" }),
					[],
				),
			}),
		);
		await tick();
		expect(queryByTestId("capture-standby-banner")).toBeTruthy();
		expect(queryByTestId("active-source-lost-banner")).toBeNull();
		expect(queryByTestId("video-signal-lost-banner")).toBeNull();
	});

	it("keeps the all-links-down band INDEPENDENT of standby — a dead bond is a different fact", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				telemetry: { links: [staleLink("1"), staleLink("2")] },
				activeEncode: activeEncode(
					"standby",
					captureBlock({ state: "standby" }),
					[],
				),
			}),
		);
		await tick();
		expect(queryByTestId("capture-standby-banner")).toBeTruthy();
		expect(queryByTestId("all-links-down-banner")).toBeTruthy();
	});

	it("does NOT show on a normal session, and renders nothing for an unknown state", async () => {
		for (const state of ["normal", "degraded", "not_a_state"]) {
			const { queryByTestId, unmount } = render(
				LiveCockpit,
				baseProps({
					...twoCameras,
					activeEncode: activeEncode("cam0", captureBlock({ state })),
				}),
			);
			await tick();
			for (const banner of CAPTURE_BANNERS) {
				expect(queryByTestId(banner)).toBeNull();
			}
			unmount();
		}
	});

	it("does NOT show in summaryMode or while idle", async () => {
		const standby = activeEncode(
			"standby",
			captureBlock({ state: "standby" }),
			[],
		);
		for (const overrides of [{ summaryMode: true }, { isStreaming: false }]) {
			const { queryByTestId, unmount } = render(
				LiveCockpit,
				baseProps({ ...twoCameras, activeEncode: standby, ...overrides }),
			);
			await tick();
			expect(queryByTestId("capture-standby-banner")).toBeNull();
			unmount();
		}
	});
});

describe("LiveCockpit — suspension bands", () => {
	it("shows the composition-suspended band for composition_primary_absent", async () => {
		const { getByTestId, queryByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"cam1",
					captureBlock({
						state: "degraded",
						suspension: {
							kind: "composition_primary_absent",
							since_ms: 1,
							resume_attempts: 0,
						},
					}),
				),
			}),
		);
		await tick();
		const band = getByTestId("composition-suspended-banner");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain(
			en.live.capture.compositionSuspendedTitle,
		);
		expect(band.textContent).toContain(
			en.live.capture.compositionSuspendedBody,
		);
		expect(queryByTestId("capture-standby-banner")).toBeNull();
		expect(queryByTestId("active-source-lost-banner")).toBeNull();
	});

	it("shows the passthrough-suspended band for passthrough_source_absent", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"cam1",
					captureBlock({
						state: "degraded",
						suspension: {
							kind: "passthrough_source_absent",
							since_ms: 1,
							resume_attempts: 0,
						},
					}),
				),
			}),
		);
		await tick();
		const band = getByTestId("passthrough-suspended-banner");
		expect(band.textContent).toContain(
			en.live.capture.passthroughSuspendedTitle,
		);
		expect(band.textContent).toContain(
			en.live.capture.passthroughSuspendedBody,
		);
	});

	it("names the backup camera's mode on the rate-adapted band", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"cam1",
					captureBlock({
						state: "degraded",
						suspension: {
							kind: "rate_adapted",
							since_ms: 1,
							resume_attempts: 0,
						},
						active_source: {
							input_id: "cam1",
							width: 1280,
							height: 720,
							framerate: 30,
							retimed: false,
							rescaled: false,
						},
					}),
				),
			}),
		);
		await tick();
		const band = getByTestId("rate-adapted-banner");
		expect(band.textContent).toContain(en.live.capture.rateAdaptedTitle);
		expect(band.textContent).toContain(
			en.live.capture.rateAdaptedBody.replace("{mode}", "720p30"),
		);
		expect(band.getAttribute("data-mode")).toBe("720p30");
	});

	it("falls back to mode-less copy when the engine names no active source", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"cam1",
					captureBlock({
						state: "degraded",
						suspension: {
							kind: "rate_adapted",
							since_ms: 1,
							resume_attempts: 0,
						},
					}),
				),
			}),
		);
		await tick();
		const band = getByTestId("rate-adapted-banner");
		expect(band.textContent).toContain(
			en.live.capture.rateAdaptedBodyUnknownMode,
		);
		expect(band.textContent).not.toContain("{mode}");
	});

	it("renders NO suspension band for a kind this build does not know", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"cam1",
					captureBlock({
						state: "degraded",
						suspension: {
							kind: "gravity_reversed",
							since_ms: 1,
							resume_attempts: 0,
						},
					}),
				),
			}),
		);
		await tick();
		for (const banner of CAPTURE_BANNERS) {
			expect(queryByTestId(banner)).toBeNull();
		}
	});

	it("uses the calm warning register, never the destructive one", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"cam1",
					captureBlock({
						state: "degraded",
						suspension: {
							kind: "composition_primary_absent",
							since_ms: 1,
							resume_attempts: 0,
						},
					}),
				),
			}),
		);
		await tick();
		const band = getByTestId("composition-suspended-banner");
		expect(band.className).toContain("status-warning");
		expect(band.className).not.toContain("destructive");
	});
});

describe("LiveCockpit — operator copy never leaks engine tokens", () => {
	it("shows no wire enum token or input id on any capture band", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				...twoCameras,
				activeEncode: activeEncode(
					"standby",
					captureBlock({
						state: "standby",
						suspension: {
							kind: "rate_adapted",
							since_ms: 1,
							resume_attempts: 0,
						},
						active_source: {
							input_id: "/dev/video7",
							width: 1920,
							height: 1080,
							framerate: 30,
							retimed: true,
							rescaled: false,
						},
					}),
					[],
				),
			}),
		);
		await tick();
		const text = [
			getByTestId("capture-standby-banner").textContent,
			getByTestId("rate-adapted-banner").textContent,
		].join(" ");
		for (const token of [
			"rate_adapted",
			"standby_since",
			"/dev/video7",
			"retime",
		]) {
			expect(text).not.toContain(token);
		}
	});
});
