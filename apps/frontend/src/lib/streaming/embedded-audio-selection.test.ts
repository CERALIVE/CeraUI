import type { StreamSource } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	carriesEmbeddedAudio,
	isDeviceAudioPick,
	planAudioSelectionForSource,
} from "./embedded-audio-selection";

const rtmp = {
	id: "rtmp",
	origin: "network",
	displayName: "RTMP Ingest",
	audioKind: "embedded",
	supportsAudio: true,
	requiresGateway: "rtmp",
	available: true,
} as unknown as StreamSource;

const camera = {
	id: "/dev/video1",
	origin: "capture",
	displayName: "DJI Osmo",
	audioKind: "selectable",
	supportsAudio: true,
	available: true,
} as unknown as StreamSource;

// A network row whose engine says its audio IS selectable must behave like a
// capture source — the rule is the audio property, never `origin === 'network'`.
const networkSelectable = {
	...rtmp,
	audioKind: "selectable",
} as unknown as StreamSource;

describe("isDeviceAudioPick — a sentinel is not a device", () => {
	it("separates a real card from every pipeline sentinel", () => {
		expect(isDeviceAudioPick("DJI Mic Mini")).toBe(true);
		expect(isDeviceAudioPick("Auto")).toBe(false);
		expect(isDeviceAudioPick("No audio")).toBe(false);
		expect(isDeviceAudioPick("Pipeline default")).toBe(false);
		expect(isDeviceAudioPick(undefined)).toBe(false);
		expect(isDeviceAudioPick("")).toBe(false);
	});
});

describe("carriesEmbeddedAudio — keyed on the audio property, not the origin", () => {
	it("is the declared audioKind and nothing else", () => {
		expect(carriesEmbeddedAudio(rtmp)).toBe(true);
		expect(carriesEmbeddedAudio(camera)).toBe(false);
		expect(carriesEmbeddedAudio(networkSelectable)).toBe(false);
	});
});

describe("planAudioSelectionForSource — the device pick travels with the source", () => {
	it("clears a device pick onto Auto when the source brings its own audio", () => {
		expect(planAudioSelectionForSource(rtmp, "DJI Mic Mini")).toEqual({
			asrc: "Auto",
		});
	});

	it("never overwrites a pick the operator made themselves", () => {
		expect(planAudioSelectionForSource(rtmp, "No audio")).toEqual({});
		expect(planAudioSelectionForSource(rtmp, "Pipeline default")).toEqual({});
	});

	it("leaves a source that still wants a device alone", () => {
		expect(planAudioSelectionForSource(camera, "DJI Mic Mini")).toEqual({});
		expect(planAudioSelectionForSource(camera, "Auto")).toEqual({});
		expect(
			planAudioSelectionForSource(networkSelectable, "DJI Mic Mini"),
		).toEqual({});
	});

	it("does nothing when there is no device pick to retire", () => {
		expect(planAudioSelectionForSource(rtmp, "Auto")).toEqual({});
		expect(planAudioSelectionForSource(rtmp, undefined)).toEqual({});
	});

	// Returning to a capture source must NOT re-apply a previously displaced pick:
	// that is the "remembers the last device audio selection" behaviour the report
	// asked to remove, and it is now unexpressible — the plan takes no memory.
	it("restores nothing on the way back", () => {
		expect(planAudioSelectionForSource(camera, "Auto")).toEqual({});
		expect(planAudioSelectionForSource.length).toBe(2);
	});
});
