import { expect, test } from "bun:test";
import type { VideoSourceCap } from "@ceralive/cerastream";
import {
	resolveAudioDisplays,
	resolveOnboardDisplayName,
} from "../modules/streaming/audio-naming.ts";
import { resolveAutoAsrc } from "../modules/streaming/auto-audio.ts";
import {
	buildDeviceList,
	fromEngineDevice,
} from "../modules/streaming/devices.ts";
import {
	buildSources,
	mergeObservedWithProbe,
} from "../modules/streaming/sources.ts";

const sources: VideoSourceCap[] = ["hdmi", "usb_mjpeg"].map((id) => ({
	id,
	supports_audio: true,
	supports_resolution_override: true,
	supports_framerate_override: true,
	default_resolution: "1080p",
	default_framerate: 30,
}));

test("keeps BRIO capture when its identically named metadata node sorts first", () => {
	// Given: the board's sysfs order includes metadata video10 before capture video7.
	const observed = buildDeviceList(
		["video10", "video7", "video8", "video9"].map((card) => ({
			card,
			name: "Logitech BRIO",
		})),
		{},
	);
	const capture = fromEngineDevice({
		input_id: "/dev/video7",
		device_path: "/dev/video7",
		display_name: "Logitech BRIO",
		media_class: "video",
		kind: "mjpeg",
		caps: [
			{
				width: 1920,
				height: 1080,
				framerate: "60/1",
				media_type: "image/jpeg",
			},
		],
	});
	// When: the real observation/probe merge feeds the picker builder.
	const rows = buildSources({
		sources,
		devices: mergeObservedWithProbe(observed, [capture], new Map()),
		networkIngest: { rtmp: null, srt: null },
	});
	// Then: the capture is selectable, and metadata is not a source.
	expect(rows.find((row) => row.id === "/dev/video7")).toMatchObject({
		origin: "capture",
		displayName: "Logitech BRIO",
		available: true,
		signal: "present",
	});
	expect(rows.some((row) => row.id === "/dev/video10")).toBe(false);
});

test("retains both same-model USB cameras in the membership scan", () => {
	const observed = buildDeviceList(
		[
			{ card: "video2", name: "USB Camera" },
			{ card: "video12", name: "USB Camera" },
		],
		{},
	);
	expect(observed.map((row) => row.input_id)).toEqual([
		"/dev/video2",
		"/dev/video12",
	]);
});

test("does not revive a genuinely absent camera from an engine probe", () => {
	const capture = fromEngineDevice({
		input_id: "/dev/video7",
		device_path: "/dev/video7",
		display_name: "Logitech BRIO",
		media_class: "video",
		kind: "mjpeg",
	});
	expect(mergeObservedWithProbe([], [capture], new Map())).toEqual([]);
});

test("names the production HDMIIN card even when PipeWire exposes no audio node", () => {
	const displays = resolveAudioDisplays(
		{ HDMIIN: "HDMIIN" },
		[],
		new Map([["HDMIIN", "RK3588 HDMI-IN"]]),
	);
	expect(displays.get("HDMIIN")).toMatchObject({
		label: "HDMI Input",
		detail: "RK3588 HDMI-IN",
	});
});

test("recognizes the RK3588 HDMI-IN longname without broad HDMI matching", () => {
	expect(resolveOnboardDisplayName("unknown", "RK3588 HDMI-IN")).toBe(
		"HDMI Input",
	);
	expect(resolveOnboardDisplayName("hdmi0", "hdmi0")).toBeUndefined();
	expect(resolveOnboardDisplayName("USB", "USB HDMI capture")).toBeUndefined();
});

test.each([true, false])(
	"Auto recognizes HDMIIN and preserves its capture-PCM gate (%s)",
	(capturePresent) => {
		const source = buildSources({
			sources,
			devices: [
				fromEngineDevice({
					input_id: "/dev/video0",
					device_path: "/dev/video0",
					display_name: "snps_hdmirx",
					kind: "hdmi",
					media_class: "video",
				}),
			],
			networkIngest: { rtmp: null, srt: null },
		}).find((row) => row.id === "/dev/video0");
		const result = resolveAutoAsrc({
			source,
			audioDevices: { HDMIIN: "HDMIIN" },
			engineAudio: [],
			networkEmbeddedAudio: false,
			captureCapableCardIds: new Set(capturePresent ? ["HDMIIN"] : []),
		});
		expect(result.reason).toBe(capturePresent ? "hdmi" : "no-capture-audio");
		expect(result.asrcKey).toBe(capturePresent ? "HDMIIN" : "No audio");
	},
);
