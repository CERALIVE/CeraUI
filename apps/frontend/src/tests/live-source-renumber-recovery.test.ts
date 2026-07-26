// @vitest-environment jsdom
/*
 * Mid-stream re-enumeration recovery (device-quality-wave2).
 *
 * A capture device unplugged and replugged WHILE STREAMING comes back on a NEW
 * node path (the engine still holds the old one, so the kernel cannot recycle
 * it). Confirmed live on a Rock 5B+: the media pipeline recovered and frames
 * resumed, but the UI never did — the "source disconnected" alert never cleared,
 * the summary label fell back to the raw `/dev/video1`, and the Switch-source
 * card disappeared, leaving an alert that says "switch to another source" with
 * nothing to switch with.
 *
 * LiveSourceSwitch is rendered FOR REAL here (not the Noop fixture the banner
 * suite uses) because the whole point is that the alert and the affordance it
 * points at must agree.
 */
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// `display-profile.svelte.ts` reads localStorage at MODULE scope, and this
// runner exposes none — the import would throw before any test ran. Hoisted so
// it lands before the component import below, not after it.
vi.hoisted(() => {
	if (globalThis.localStorage !== undefined) return;
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, String(v)),
			removeItem: (k: string) => void store.delete(k),
			clear: () => store.clear(),
			key: (i: number) => [...store.keys()][i] ?? null,
			get length() {
				return store.size;
			},
		},
	});
});

vi.mock("$lib/components/custom/IngestStats.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/BitrateAdjuster.svelte", async () => ({
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

const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
const RODE_STABLE_ID = "usb:19f7:0037";

// biome-ignore lint/suspicious/noExplicitAny: minimal props shim for a presentational cockpit render
function baseProps(overrides: Record<string, any>): any {
	return {
		liveSummary: { source: RODE_NAME, parts: [] },
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

// biome-ignore lint/suspicious/noExplicitAny: schema-shaped row literal for a render fixture
function capture(id: string, overrides: Record<string, any> = {}): any {
	return {
		id,
		origin: "capture",
		kind: "mjpeg",
		displayName: id,
		devicePath: id,
		pipelineId: "usb_mjpeg",
		available: true,
		modes: [],
		audioKind: "none",
		...overrides,
	};
}

const ONBOARD_HDMI = capture("/dev/video0", {
	kind: "hdmi",
	displayName: "HDMI Input",
	pipelineId: "hdmi",
});

/** The engine keeps naming the node it opened at start. */
const ACTIVE_ENCODE = {
	codec: "h264",
	resolution: "1920x1080",
	framerate: 30,
	active_input: "/dev/video1",
};

afterEach(() => cleanup());

describe("mid-stream re-enumeration — alert and switch affordance stay in step", () => {
	it("while LOST: alert shows AND the switch card is offered", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "/dev/video1" },
				activeEncode: ACTIVE_ENCODE,
				activeInput: "/dev/video1",
				sources: {
					hardware: [],
					sources: [
						ONBOARD_HDMI,
						capture("/dev/video1", {
							displayName: RODE_NAME,
							lost: true,
							available: false,
						}),
					],
				},
			}),
		);
		await tick();

		expect(getByTestId("active-source-lost-banner")).toBeTruthy();
		expect(getByTestId("live-source-switch")).toBeTruthy();
	});

	it("after RECOVERY on a new node: alert clears and the device keeps its name", async () => {
		const { queryByTestId, getByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "/dev/video2" },
				activeEncode: ACTIVE_ENCODE,
				activeInput: "/dev/video2",
				sources: {
					hardware: [],
					sources: [
						ONBOARD_HDMI,
						capture("/dev/video2", {
							displayName: RODE_NAME,
							stableId: RODE_STABLE_ID,
							previousIds: ["/dev/video1"],
						}),
					],
				},
			}),
		);
		await tick();

		expect(queryByTestId("active-source-lost-banner")).toBeNull();
		// The affordance survives recovery instead of vanishing with the device.
		const card = getByTestId("live-source-switch");
		expect(card.textContent).toContain(RODE_NAME);
	});

	it("a source that is genuinely gone still alarms — the alias is not a catch-all", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "/dev/video1" },
				activeEncode: ACTIVE_ENCODE,
				sources: {
					hardware: [],
					sources: [
						ONBOARD_HDMI,
						capture("/dev/video2", {
							displayName: "A Completely Different Camera",
							stableId: "usb:dead:beef",
						}),
					],
				},
			}),
		);
		await tick();

		expect(getByTestId("active-source-lost-banner")).toBeTruthy();
		expect(getByTestId("live-source-switch")).toBeTruthy();
	});

	it("no switch card when there is genuinely nothing to switch to", async () => {
		const { getByTestId, queryByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "/dev/video1" },
				activeEncode: ACTIVE_ENCODE,
				sources: {
					hardware: [],
					sources: [capture("/dev/video1", { lost: true })],
				},
			}),
		);
		await tick();

		expect(getByTestId("active-source-lost-banner")).toBeTruthy();
		expect(queryByTestId("live-source-switch")).toBeNull();
	});
});
