import { intersectCaps } from "@ceraui/rpc";
import {
	type ActiveEncode,
	type CapabilitiesMessage,
	type CaptureStreamSource,
	ROUTE_REASONS,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import en from "../../../../../packages/i18n/messages/en.json";
import {
	automaticCodec,
	codecLabel,
	expectedOutputCodec,
	manualCodecs,
	type RouteInput,
	resolveRoute,
	routeCopy,
	routeReasonKey,
} from "./outputFormat";

const HW_PLATFORM = {
	supports_h265: true,
	hardware_accelerated: true,
	max_resolution: "3840x2160",
};
const SW_PLATFORM = {
	supports_h265: false,
	hardware_accelerated: false,
	max_resolution: "1920x1080",
};

function caps(
	encoder: Partial<CapabilitiesMessage["encoder"]> = {},
): CapabilitiesMessage {
	return {
		platform: HW_PLATFORM,
		encoder: {
			codecs: ["H264", "H265"],
			bitrate_range: { min: 500, max: 12000, unit: "kbps" },
			...encoder,
		},
		sources: [],
	} as CapabilitiesMessage;
}

function camera(
	kind: CaptureStreamSource["kind"],
	mediaTypes: string[],
	extra: Partial<CaptureStreamSource> = {},
): CaptureStreamSource {
	return {
		id: `${kind}-0`,
		origin: "capture",
		pipelineId: kind,
		kind,
		displayName: `${kind} camera`,
		devicePath: "/dev/video1",
		modes: mediaTypes.map((media_type) => ({
			width: 1920,
			height: 1080,
			framerates: [30],
			media_type,
		})),
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "none",
		available: true,
		...extra,
	} as CaptureStreamSource;
}

const H265_CAM = camera("uvc_h265", ["video/x-h265"]);
const H264_CAM = camera("uvc_h264", ["video/x-h264"]);
const MJPEG_CAM = camera("mjpeg", ["image/jpeg"]);
const HDMI = camera("hdmi", ["video/x-raw"]);
// A dual-format camera opened in its MJPEG family: only that family can reach
// the output, so its H.264 modes must not make it look passthrough-capable.
const DUAL_IN_MJPEG = camera("uvc_h264", ["video/x-h264", "image/jpeg"], {
	inputModes: [
		{
			inputMode: "uvc_h264",
			mediaType: "video/x-h264",
			pipelineId: "libuvch264",
			modes: [],
		},
		{
			inputMode: "mjpeg",
			mediaType: "image/jpeg",
			pipelineId: "usb_mjpeg",
			modes: [],
		},
	],
	selectedInputMode: "mjpeg",
});

function preStart(partial: Partial<RouteInput>): RouteInput {
	return {
		outputCodec: "h265",
		balancer: undefined,
		passthrough: undefined,
		source: H265_CAM,
		...partial,
	};
}

function live(
	encode: Partial<ActiveEncode>,
	partial: Partial<RouteInput> = {},
): RouteInput {
	return preStart({
		activeEncode: {
			codec: "h265",
			resolution: "1920x1080",
			framerate: 30,
			...encode,
		},
		...partial,
	});
}

describe("automaticCodec", () => {
	it("returns the codec the engine names as its default", () => {
		expect(automaticCodec(caps({ default_codec: "h265" }))).toBe("h265");
	});

	it("is undefined when the engine does not name a default", () => {
		expect(automaticCodec(caps())).toBeUndefined();
		expect(automaticCodec(undefined)).toBeUndefined();
	});
});

describe("manualCodecs", () => {
	it("offers exactly the codecs intersectCaps offers", () => {
		expect(
			manualCodecs(intersectCaps(HW_PLATFORM, undefined, "streaming")),
		).toEqual(["h264", "h265"]);
		expect(
			manualCodecs(intersectCaps(SW_PLATFORM, undefined, "streaming")),
		).toEqual(["h264"]);
	});
});

describe("codecLabel", () => {
	it("names each codec the way operators read it", () => {
		expect(codecLabel("h264")).toBe("H.264");
		expect(codecLabel("h265")).toBe("H.265");
		expect(codecLabel("av1")).toBe("AV1");
		expect(codecLabel("mjpeg")).toBe("MJPEG");
	});
});

describe("expectedOutputCodec", () => {
	it("prefers the operator's pick, then the engine's default, then the platform default", () => {
		expect(
			expectedOutputCodec("h264", caps({ default_codec: "h265" }), HW_PLATFORM),
		).toBe("h264");
		expect(
			expectedOutputCodec(
				undefined,
				caps({ default_codec: "av1" }),
				HW_PLATFORM,
			),
		).toBe("av1");
		expect(expectedOutputCodec(undefined, undefined, HW_PLATFORM)).toBe("h265");
		expect(expectedOutputCodec(undefined, undefined, SW_PLATFORM)).toBe("h264");
	});
});

describe("resolveRoute before start (first match wins)", () => {
	it("untouched: a saved force with a source that offers the output codec", () => {
		expect(resolveRoute(preStart({ passthrough: "force" }))).toMatchObject({
			outcome: "untouched",
			outputCodec: "h265",
		});
	});

	it("forceUnavailable: a saved force with any other source, never untouched", () => {
		const route = resolveRoute(
			preStart({ passthrough: "force", source: MJPEG_CAM }),
		);
		expect(route.outcome).toBe("forceUnavailable");
		expect(route.outputCodec).toBe("h265");
	});

	it("encoded: a raw source such as HDMI", () => {
		expect(resolveRoute(preStart({ source: HDMI }))).toMatchObject({
			outcome: "encoded",
			outputCodec: "h265",
		});
	});

	it("willTryUntouched: balancer fixed, no saved off, and a source that offers the output codec", () => {
		expect(resolveRoute(preStart({ balancer: "fixed" })).outcome).toBe(
			"willTryUntouched",
		);
		expect(
			resolveRoute(preStart({ balancer: "fixed", passthrough: "auto" }))
				.outcome,
		).toBe("willTryUntouched");
	});

	it("sameFormatFixed: a saved off keeps a fixed-bitrate same-format source re-encoded", () => {
		expect(
			resolveRoute(preStart({ balancer: "fixed", passthrough: "off" })).outcome,
		).toBe("sameFormatFixed");
	});

	it("sameFormatAdapted: a source that offers the output codec under any adaptive balancer", () => {
		for (const balancer of [undefined, "adaptive", "aimd"] as const) {
			expect(resolveRoute(preStart({ balancer }))).toMatchObject({
				outcome: "sameFormatAdapted",
				inputCodec: "h265",
				outputCodec: "h265",
			});
		}
	});

	it("converted: a source in another format, naming both codecs", () => {
		expect(resolveRoute(preStart({ source: MJPEG_CAM }))).toMatchObject({
			outcome: "converted",
			inputCodec: "mjpeg",
			outputCodec: "h265",
		});
		expect(resolveRoute(preStart({ source: H264_CAM }))).toMatchObject({
			outcome: "converted",
			inputCodec: "h264",
			outputCodec: "h265",
		});
	});

	it("reads a multi-format camera in the format it is opened in", () => {
		expect(
			resolveRoute(preStart({ source: DUAL_IN_MJPEG, outputCodec: "h264" })),
		).toMatchObject({ outcome: "converted", inputCodec: "mjpeg" });
		expect(
			resolveRoute(
				preStart({
					source: DUAL_IN_MJPEG,
					outputCodec: "h264",
					passthrough: "force",
				}),
			).outcome,
		).toBe("forceUnavailable");
	});
});

describe("resolveRoute while live (the engine's active encode wins)", () => {
	it("untouched: the engine reports passthrough", () => {
		expect(
			resolveRoute(
				live({
					passthrough: true,
					input_codec: "h265",
					route_reason: "passthrough",
				}),
			),
		).toMatchObject({
			outcome: "untouched",
			outputCodec: "h265",
			reason: "passthrough",
		});
	});

	it("encoded: no input codec (a raw source)", () => {
		expect(
			resolveRoute(live({ route_reason: "not-compressed" })),
		).toMatchObject({
			outcome: "encoded",
			reason: "not-compressed",
		});
	});

	it("sameFormatAdapted / sameFormatFixed: input codec equals the output codec", () => {
		expect(
			resolveRoute(
				live(
					{ input_codec: "h265", route_reason: "adaptive-active" },
					{ balancer: "aimd" },
				),
			),
		).toMatchObject({
			outcome: "sameFormatAdapted",
			reason: "adaptive-active",
		});
		expect(
			resolveRoute(
				live(
					{ codec: "h264", input_codec: "h264", route_reason: "gop-too-long" },
					{ balancer: "fixed" },
				),
			),
		).toMatchObject({ outcome: "sameFormatFixed", reason: "gop-too-long" });
	});

	it("converted: any other input codec", () => {
		expect(
			resolveRoute(live({ input_codec: "h264", route_reason: "cross-codec" })),
		).toMatchObject({
			outcome: "converted",
			inputCodec: "h264",
			outputCodec: "h265",
			reason: "cross-codec",
		});
	});

	it("ignores the saved settings once the engine has answered", () => {
		expect(
			resolveRoute(
				live(
					{ input_codec: "h264" },
					{ passthrough: "force", source: H265_CAM },
				),
			).outcome,
		).toBe("converted");
		expect(resolveRoute(live({})).reason).toBeUndefined();
	});
});

describe("routeCopy", () => {
	it("keys each outcome under live.encoder.route with operator codec labels", () => {
		expect(
			routeCopy({
				outcome: "converted",
				inputCodec: "mjpeg",
				outputCodec: "h265",
			}),
		).toEqual({
			key: "live.encoder.route.converted",
			params: { input: "MJPEG", output: "H.265" },
		});
		for (const outcome of [
			"untouched",
			"forceUnavailable",
			"sameFormatAdapted",
			"sameFormatFixed",
			"encoded",
			"willTryUntouched",
		] as const) {
			const copy = routeCopy({ outcome, outputCodec: "h264" });
			expect(copy).toEqual({
				key: `live.encoder.route.${outcome}`,
				params: { codec: "H.264" },
			});
			expect(en).toHaveProperty([copy.key]);
		}
		expect(en).toHaveProperty(["live.encoder.route.converted"]);
	});
});

describe("routeReasonKey", () => {
	it("maps every producer route reason to its own catalog key", () => {
		for (const reason of ROUTE_REASONS) {
			const key = routeReasonKey(reason);
			expect(key).toBe(`live.encoder.route.reason.${reason}`);
			expect(en).toHaveProperty([key as string]);
		}
	});

	it("renders nothing for an absent or unknown reason, never the raw token", () => {
		expect(routeReasonKey(undefined)).toBeUndefined();
		expect(routeReasonKey("some-future-reason")).toBeUndefined();
	});
});
