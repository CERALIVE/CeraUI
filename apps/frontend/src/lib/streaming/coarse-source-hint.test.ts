import type {
	CaptureStreamSource,
	CoarseStreamSource,
	NetworkStreamSource,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveCoarseUnboundState,
	MAX_COARSE_SUGGESTIONS,
	suggestedCapturesForCoarse,
} from "./coarse-source-hint";

// The exact live board layout behind the operator report: an RK3588 whose
// on-board HDMI-RX never bridges to the coarse `hdmi` pipeline, plus a RØDE
// HDMI-to-USB-C adapter that enumerates as its own correctly-detected UVC row.
const COARSE_HDMI: CoarseStreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};

function capture(over: Partial<CaptureStreamSource> = {}): CaptureStreamSource {
	return {
		origin: "capture",
		id: "/dev/video1",
		pipelineId: "usb_mjpeg",
		kind: "mjpeg",
		displayName: "RØDE HDMI to USB-C: RØDE HDMI",
		devicePath: "/dev/video1",
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
		...over,
	};
}

const NETWORK_RTMP: NetworkStreamSource = {
	origin: "network",
	id: "rtmp",
	pipelineId: "rtmp",
	labelKey: "settings.sources.rtmp",
	requiresGateway: "rtmp",
	url: null,
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "embedded",
	available: true,
};

describe("suggestedCapturesForCoarse", () => {
	it("points at a connected device whose real hardware name carries the coarse row's token", () => {
		const rode = capture();
		expect(
			suggestedCapturesForCoarse(COARSE_HDMI, [COARSE_HDMI, rode]),
		).toEqual([rode]);
	});

	it("matches case-insensitively", () => {
		const lower = capture({ displayName: "generic hdmi grabber" });
		expect(suggestedCapturesForCoarse(COARSE_HDMI, [lower])).toEqual([lower]);
	});

	it("suggests nothing when no connected device's name relates to the capability", () => {
		const webcam = capture({
			id: "/dev/video3",
			displayName: "Logitech BRIO Webcam",
		});
		expect(
			suggestedCapturesForCoarse(COARSE_HDMI, [COARSE_HDMI, webcam]),
		).toEqual([]);
	});

	it("never suggests a lost or unavailable device", () => {
		const lost = capture({ id: "lost", lost: true });
		const unavailable = capture({ id: "unavailable", available: false });
		expect(
			suggestedCapturesForCoarse(COARSE_HDMI, [lost, unavailable]),
		).toEqual([]);
	});

	it("only considers capture rows — never another coarse, virtual, or network row", () => {
		const otherCoarse: CoarseStreamSource = {
			...COARSE_HDMI,
			id: "hdmi-alt",
			pipelineId: "hdmi-alt",
		};
		expect(
			suggestedCapturesForCoarse(COARSE_HDMI, [otherCoarse, NETWORK_RTMP]),
		).toEqual([]);
	});

	it("returns nothing for a non-coarse source", () => {
		const rode = capture();
		expect(suggestedCapturesForCoarse(rode, [rode])).toEqual([]);
		expect(suggestedCapturesForCoarse(NETWORK_RTMP, [rode])).toEqual([]);
	});

	it("tolerates an absent source list", () => {
		expect(suggestedCapturesForCoarse(COARSE_HDMI, undefined)).toEqual([]);
		expect(suggestedCapturesForCoarse(undefined, [capture()])).toEqual([]);
	});

	it("preserves broadcast order and caps the suggestion count", () => {
		const many: StreamSource[] = Array.from({ length: 5 }, (_, i) =>
			capture({ id: `hdmi-cap-${i}`, displayName: `HDMI grabber ${i}` }),
		);
		const result = suggestedCapturesForCoarse(COARSE_HDMI, many);
		expect(result).toHaveLength(MAX_COARSE_SUGGESTIONS);
		expect(result.map((s) => s.id)).toEqual([
			"hdmi-cap-0",
			"hdmi-cap-1",
			"hdmi-cap-2",
		]);
	});
});

describe("deriveCoarseUnboundState", () => {
	it("flags the coarse row only while it IS the selection", () => {
		const rode = capture();
		expect(
			deriveCoarseUnboundState(COARSE_HDMI, true, [COARSE_HDMI, rode]),
		).toEqual({ unbound: true, suggestions: [rode] });
		expect(
			deriveCoarseUnboundState(COARSE_HDMI, false, [COARSE_HDMI, rode]),
		).toEqual({ unbound: false, suggestions: [] });
	});

	it("never flags a concrete capture row, selected or not", () => {
		const rode = capture();
		expect(deriveCoarseUnboundState(rode, true, [rode])).toEqual({
			unbound: false,
			suggestions: [],
		});
	});

	it("still flags a selected coarse row with no plausible alternative", () => {
		expect(deriveCoarseUnboundState(COARSE_HDMI, true, [COARSE_HDMI])).toEqual({
			unbound: true,
			suggestions: [],
		});
	});
});
