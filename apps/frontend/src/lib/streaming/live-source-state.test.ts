/*
 * Mid-stream re-enumeration recovery + alert/affordance coupling
 * (device-quality-wave2).
 *
 * Live on a Rock 5B+: a RØDE HDMI-to-USB-C unplugged and replugged WHILE
 * STREAMING came back as /dev/video2 (the engine still held /dev/video1, so the
 * kernel could not recycle the node). Frames resumed and the engine reported
 * recovered, but the UI never reconciled — the alert stayed up forever and the
 * Switch-source card disappeared, so the banner instructed the operator to
 * "switch to another source" with nothing left to switch with.
 */
import type { StreamSource } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	canOfferLiveSourceSwitch,
	deriveLiveSourceState,
} from "./live-source-state";

const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
const RODE_STABLE_ID = "usb:19f7:0037";

const base = {
	modes: [],
	supportsAudio: false,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "none" as const,
	available: true,
};

function capture(
	id: string,
	overrides: Partial<StreamSource> = {},
): StreamSource {
	return {
		...base,
		origin: "capture",
		id,
		pipelineId: "usb_mjpeg",
		kind: "mjpeg",
		displayName: id,
		devicePath: id,
		...overrides,
	} as StreamSource;
}

const ONBOARD_HDMI = capture("/dev/video0", {
	kind: "hdmi",
	pipelineId: "hdmi",
	displayName: "HDMI Input",
});

const RODE_LOST = capture("/dev/video1", {
	displayName: RODE_NAME,
	lost: true,
	available: false,
});

const RODE_RENUMBERED = capture("/dev/video2", {
	displayName: RODE_NAME,
	stableId: RODE_STABLE_ID,
	previousIds: ["/dev/video1"],
});

const STREAMING = { isStreaming: true, summaryMode: false };

describe("deriveLiveSourceState — the mid-stream source verdict", () => {
	it("reports lost while the device is unplugged", () => {
		const state = deriveLiveSourceState({
			...STREAMING,
			activeInput: "/dev/video1",
			configSource: "/dev/video1",
			sources: [ONBOARD_HDMI, RODE_LOST],
		});
		expect(state.sourceLost).toBe(true);
	});

	// The engine keeps naming the node it opened at start; the successor carries
	// that retired id as a proven alias, so the device reads as MOVED, not gone.
	it("clears once the device returns on a NEW node, even with a stale active_input", () => {
		const state = deriveLiveSourceState({
			...STREAMING,
			activeInput: "/dev/video1",
			configSource: "/dev/video2",
			sources: [ONBOARD_HDMI, RODE_RENUMBERED],
		});
		expect(state.sourceLost).toBe(false);
		expect(state.runningSource?.id).toBe("/dev/video2");
	});

	it("still reports lost when a DIFFERENT device took the freed node", () => {
		const state = deriveLiveSourceState({
			...STREAMING,
			activeInput: "/dev/video1",
			configSource: "/dev/video1",
			sources: [
				ONBOARD_HDMI,
				capture("/dev/video2", {
					displayName: "A Completely Different Camera",
					stableId: "usb:dead:beef",
				}),
			],
		});
		expect(state.sourceLost).toBe(true);
	});

	it("stays quiet before the first sources broadcast, while idle, and in summaryMode", () => {
		const args = {
			activeInput: "/dev/video1",
			configSource: "/dev/video1",
			sources: [ONBOARD_HDMI],
		};
		expect(
			deriveLiveSourceState({ ...args, ...STREAMING, sources: [] }).sourceLost,
		).toBe(false);
		expect(
			deriveLiveSourceState({ ...args, isStreaming: false, summaryMode: false })
				.sourceLost,
		).toBe(false);
		expect(
			deriveLiveSourceState({ ...args, isStreaming: true, summaryMode: true })
				.sourceLost,
		).toBe(false);
	});

	it("keeps engine active_input winning over config.source (precedence unchanged)", () => {
		const state = deriveLiveSourceState({
			...STREAMING,
			activeInput: "cam9",
			configSource: "cam0",
			sources: [capture("cam0"), ONBOARD_HDMI],
		});
		expect(state.sourceLost).toBe(true);
	});
});

describe("canOfferLiveSourceSwitch — never disagrees with the alert", () => {
	it("offers the switch whenever the source is lost and alternatives exist", () => {
		expect(canOfferLiveSourceSwitch(undefined, 2, true)).toBe(true);
		expect(canOfferLiveSourceSwitch(RODE_LOST, 2, true)).toBe(true);
	});

	it("keeps offering it after recovery (a healthy capture session)", () => {
		expect(canOfferLiveSourceSwitch(RODE_RENUMBERED, 2, false)).toBe(true);
	});

	it("stays down for a non-capture session and for a lone capture source", () => {
		const network = capture("rtmp", {
			origin: "network",
		} as Partial<StreamSource>);
		expect(canOfferLiveSourceSwitch(network, 2, false)).toBe(false);
		expect(canOfferLiveSourceSwitch(RODE_RENUMBERED, 1, false)).toBe(false);
	});

	// The load-bearing invariant: the alert copy says "switch to another source to
	// keep your stream alive", so whenever it is on screen and a target exists, the
	// affordance MUST be reachable. Exhaustive over the whole input space.
	it("INVARIANT: alert + ≥2 capture sources ⇒ the switch card is always offered", () => {
		const runningSources: (StreamSource | undefined)[] = [
			undefined,
			RODE_LOST,
			RODE_RENUMBERED,
			capture("rtmp", { origin: "network" } as Partial<StreamSource>),
		];
		for (const runningSource of runningSources) {
			for (const count of [2, 3, 8]) {
				expect(canOfferLiveSourceSwitch(runningSource, count, true)).toBe(true);
			}
		}
	});
});
