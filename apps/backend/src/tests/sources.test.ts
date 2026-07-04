import { beforeEach, describe, expect, it } from "bun:test";
import type {
	GetCapabilitiesResult,
	ListDevicesResult,
} from "@ceralive/cerastream";
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { streamSourceSchema } from "@ceraui/rpc/schemas";
import {
	buildSources,
	deriveEngineRouting,
	getEngineDeviceCache,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

type CapabilitySource = GetCapabilitiesResult["sources"][number];

function capSource(
	id: string,
	overrides: Partial<CapabilitySource> = {},
): CapabilitySource {
	return {
		id,
		supports_audio: overrides.supports_audio ?? false,
		supports_resolution_override:
			overrides.supports_resolution_override ?? true,
		supports_framerate_override: overrides.supports_framerate_override ?? true,
		default_resolution: overrides.default_resolution ?? "1080p",
		default_framerate: overrides.default_framerate ?? 30,
	};
}

// today's pipeline registry set (buildPipelineRegistry keys by cap.id) — the
// golden fixture the coarse ids must reproduce byte-for-byte.
const GOLDEN_SOURCE_IDS = [
	"hdmi",
	"usb_mjpeg",
	"v4l_mjpeg",
	"camlink",
	"libuvch264",
	"rtmp",
	"srt",
	"test",
] as const;

function goldenCapSources(): CapabilitySource[] {
	return GOLDEN_SOURCE_IDS.map((id) => capSource(id));
}

function captureDevice(
	input_id: string,
	kind: DeviceKind,
	overrides: Partial<CaptureDevice> = {},
): CaptureDevice {
	return {
		input_id,
		device_path: overrides.device_path ?? `/dev/${input_id}`,
		display_name: overrides.display_name ?? input_id,
		media_class: overrides.media_class ?? "video",
		kind,
		...(overrides.caps !== undefined ? { caps: overrides.caps } : {}),
	};
}

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

function activeIngest(): NetworkIngest {
	return {
		rtmp: { service_active: true, url: "rtmp://10.0.0.5:1935/publish/live" },
		srt: { service_active: true, url: "srt://10.0.0.5:4001" },
	};
}

describe("buildSources — caps-first base + device overlay", () => {
	it("emits a coarse entry per non-device capability source with ids identical to the pipeline registry (golden fixture)", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: activeIngest(),
		});

		// ids identical to today's pipeline registry, same order.
		expect(sources.map((s) => s.id)).toEqual([...GOLDEN_SOURCE_IDS]);

		const byId = new Map(sources.map((s) => [s.id, s]));
		expect(byId.get("hdmi")?.origin).toBe("coarse");
		expect(byId.get("usb_mjpeg")?.origin).toBe("coarse");
		expect(byId.get("v4l_mjpeg")?.origin).toBe("coarse");
		expect(byId.get("camlink")?.origin).toBe("coarse");
		expect(byId.get("libuvch264")?.origin).toBe("coarse");
		expect(byId.get("rtmp")?.origin).toBe("network");
		expect(byId.get("srt")?.origin).toBe("network");
		expect(byId.get("test")?.origin).toBe("virtual");

		// every emitted source is schema-valid.
		for (const source of sources) {
			expect(() => streamSourceSchema.parse(source)).not.toThrow();
		}
	});

	it("legacy engine (no devices) yields exactly today's coarse pipeline ids", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
		});
		const coarseIds = sources
			.filter((s) => s.origin === "coarse")
			.map((s) => s.id);
		expect(coarseIds).toEqual([
			"hdmi",
			"usb_mjpeg",
			"v4l_mjpeg",
			"camlink",
			"libuvch264",
		]);
	});

	it("replaces the hdmi coarse entry with two capture entries for two same-kind HDMI dongles", () => {
		const caps = [{ width: 1920, height: 1080, framerate: "30" }];
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [
				captureDevice("video0", "hdmi", {
					display_name: "Elgato Cam Link 4K",
					caps,
				}),
				captureDevice("video1", "hdmi", {
					display_name: "Magewell USB Capture HDMI",
					caps,
				}),
			],
			networkIngest: activeIngest(),
		});

		const captures = sources.filter((s) => s.origin === "capture");
		expect(captures).toHaveLength(2);
		expect(captures.map((s) => s.id)).toEqual(["video0", "video1"]);
		// real hardware names, verbatim (kills the USB-as-HDMI mislabel).
		const names = captures.map((s) =>
			s.origin === "capture" ? s.displayName : "",
		);
		expect(names).toEqual(["Elgato Cam Link 4K", "Magewell USB Capture HDMI"]);
		// each capture bridges to the hdmi pipeline and carries grouped modes.
		for (const capture of captures) {
			expect(capture.pipelineId).toBe("hdmi");
			expect(capture.modes.length).toBeGreaterThan(0);
			expect(capture.modes[0]?.width).toBe(1920);
		}

		// the hdmi coarse entry is GONE (replaced, not appended).
		const hdmiCoarse = sources.find(
			(s) => s.origin === "coarse" && s.id === "hdmi",
		);
		expect(hdmiCoarse).toBeUndefined();
		// no other coarse entry was lost.
		expect(
			sources.filter((s) => s.origin === "coarse").map((s) => s.id),
		).toEqual(["usb_mjpeg", "v4l_mjpeg", "camlink", "libuvch264"]);
	});

	it("inherits facet flags from the replaced coarse entry onto capture entries", () => {
		const sources = buildSources({
			sources: [
				capSource("hdmi", {
					supports_audio: true,
					supports_resolution_override: false,
					supports_framerate_override: true,
					default_resolution: "1080p",
					default_framerate: 60,
				}),
			],
			devices: [captureDevice("video0", "hdmi", { display_name: "HDMI-RX" })],
			networkIngest: NO_INGEST,
		});

		const capture = sources.find((s) => s.origin === "capture");
		expect(capture).toBeDefined();
		expect(capture?.supportsAudio).toBe(true);
		expect(capture?.supportsResolutionOverride).toBe(false);
		expect(capture?.supportsFramerateOverride).toBe(true);
		expect(capture?.defaultResolution).toBe("1080p");
		expect(capture?.defaultFramerate).toBe(60);
		expect(capture?.audioKind).toBe("selectable");
	});

	it("leaves the coarse entry intact for an unbridged usb device (no per-device entry)", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [
				captureDevice("video0", "usb", {
					display_name: "RØDE HDMI to USB-C: RØDE HDMI",
				}),
			],
			networkIngest: activeIngest(),
		});

		// no capture entry was produced for the unbridged usb device.
		expect(sources.some((s) => s.origin === "capture")).toBe(false);
		// every coarse entry survives, including hdmi.
		expect(
			sources.filter((s) => s.origin === "coarse").map((s) => s.id),
		).toEqual(["hdmi", "usb_mjpeg", "v4l_mjpeg", "camlink", "libuvch264"]);
	});

	it("ignores audio-class devices in the overlay", () => {
		const sources = buildSources({
			sources: [capSource("hdmi")],
			devices: [
				captureDevice("audio:0", "audio", { media_class: "audio" }),
				captureDevice("hdmiaudio", "hdmi", { media_class: "audio" }),
			],
			networkIngest: NO_INGEST,
		});
		expect(sources.some((s) => s.origin === "capture")).toBe(false);
		expect(sources[0]?.origin).toBe("coarse");
	});

	it("emits the test pattern as exactly one virtual entry, even with a test-kind device present", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [captureDevice("videotest", "test")],
			networkIngest: activeIngest(),
		});
		const virtuals = sources.filter((s) => s.origin === "virtual");
		expect(virtuals).toHaveLength(1);
		expect(virtuals[0]?.id).toBe("test");
		// the test-kind device did NOT create a capture entry (test is not coarse).
		expect(sources.some((s) => s.origin === "capture")).toBe(false);
	});

	it("keeps an inactive-gateway rtmp source VISIBLE with available:false + reason", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: {
				rtmp: { service_active: false, url: null },
				srt: { service_active: true, url: "srt://10.0.0.5:4001" },
			},
		});

		const rtmp = sources.find((s) => s.id === "rtmp");
		expect(rtmp?.origin).toBe("network");
		expect(rtmp?.available).toBe(false);
		expect(rtmp?.unavailableReason).toBe(
			"live.education.reason.gatewayInactive",
		);

		const srt = sources.find((s) => s.id === "srt");
		expect(srt?.available).toBe(true);
		if (srt?.origin === "network") {
			expect(srt.url).toBe("srt://10.0.0.5:4001");
		}
	});

	it("emits network sources with available:false when the gateway snapshot is null (never dropped)", () => {
		const sources = buildSources({
			sources: [capSource("rtmp"), capSource("srt"), capSource("test")],
			devices: [],
			networkIngest: NO_INGEST,
		});
		const rtmp = sources.find((s) => s.id === "rtmp");
		const srt = sources.find((s) => s.id === "srt");
		expect(rtmp?.origin).toBe("network");
		expect(rtmp?.available).toBe(false);
		expect(rtmp?.unavailableReason).toBe(
			"live.education.reason.gatewayInactive",
		);
		expect(srt?.available).toBe(false);
		if (rtmp?.origin === "network") expect(rtmp.url).toBeNull();
	});

	it("degrades to the minimal test-pattern floor without throwing (engine-starting)", () => {
		const sources = buildSources({
			sources: [capSource("test")],
			devices: [],
			networkIngest: NO_INGEST,
		});
		expect(sources).toHaveLength(1);
		expect(sources[0]?.origin).toBe("virtual");
		expect(sources[0]?.id).toBe("test");
	});
});

describe("deriveEngineRouting — all four origin arms", () => {
	function fixtureSources(): StreamSource[] {
		return buildSources({
			sources: [capSource("hdmi"), capSource("rtmp"), capSource("test")],
			devices: [captureDevice("video0", "hdmi")],
			networkIngest: activeIngest(),
		});
	}

	it("capture → pipeline = bridged id + selected_video_input = input_id", () => {
		const routing = deriveEngineRouting("video0", fixtureSources());
		expect(routing).toEqual({
			pipeline: "hdmi",
			selected_video_input: "video0",
		});
	});

	it("network → pipeline = id + selected_video_input undefined (config-clear)", () => {
		const routing = deriveEngineRouting("rtmp", fixtureSources());
		expect(routing?.pipeline).toBe("rtmp");
		expect(routing?.selected_video_input).toBeUndefined();
		expect("selected_video_input" in (routing ?? {})).toBe(true);
	});

	it("virtual → pipeline = 'test' + selected_video_input undefined (config-clear)", () => {
		const routing = deriveEngineRouting("test", fixtureSources());
		expect(routing?.pipeline).toBe("test");
		expect(routing?.selected_video_input).toBeUndefined();
		expect("selected_video_input" in (routing ?? {})).toBe(true);
	});

	it("coarse → pipeline = id + selected_video_input undefined (config-clear)", () => {
		// a coarse hdmi survives when no device bridges to it.
		const sources = buildSources({
			sources: [capSource("hdmi")],
			devices: [],
			networkIngest: NO_INGEST,
		});
		const routing = deriveEngineRouting("hdmi", sources);
		expect(routing?.pipeline).toBe("hdmi");
		expect(routing?.selected_video_input).toBeUndefined();
		expect("selected_video_input" in (routing ?? {})).toBe(true);
	});

	it("unknown source id → undefined", () => {
		expect(deriveEngineRouting("nope", fixtureSources())).toBeUndefined();
	});
});

describe("engine-device cache", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
	});

	it("retains the last-known device list across an engine-unavailable rung", async () => {
		const live: ListDevicesResult = {
			devices: [
				{
					input_id: "video0",
					device_path: "/dev/video0",
					display_name: "HDMI Capture",
					media_class: "video",
					kind: "hdmi",
					caps: [{ width: 1920, height: 1080, framerate: "30" }],
				},
			],
		};

		await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });
		expect(getEngineDeviceCache()).toHaveLength(1);
		expect(getEngineDeviceCache()[0]?.display_name).toBe("HDMI Capture");

		// engine goes unavailable (fetch throws) — the cache is NOT discarded.
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => {
				throw new Error("engine unavailable");
			},
		});
		expect(getEngineDeviceCache()).toHaveLength(1);
		expect(getEngineDeviceCache()[0]?.display_name).toBe("HDMI Capture");
	});

	it("replaces the cache wholesale on a successful (even empty) fetch", async () => {
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [
					{
						input_id: "video0",
						device_path: "/dev/video0",
						display_name: "HDMI Capture",
						media_class: "video",
						kind: "hdmi",
					},
				],
			}),
		});
		expect(getEngineDeviceCache()).toHaveLength(1);

		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({ devices: [] }),
		});
		expect(getEngineDeviceCache()).toHaveLength(0);
	});

	it("feeds a refreshed cache into buildSources as capture entries", async () => {
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [
					{
						input_id: "video0",
						device_path: "/dev/video0",
						display_name: "Magewell HDMI",
						media_class: "video",
						kind: "hdmi",
						caps: [{ width: 1920, height: 1080, framerate: "60" }],
					},
				],
			}),
		});
		const sources = buildSources({
			sources: [capSource("hdmi")],
			devices: getEngineDeviceCache(),
			networkIngest: NO_INGEST,
		});
		const capture = sources.find((s) => s.origin === "capture");
		expect(capture?.origin).toBe("capture");
		if (capture?.origin === "capture") {
			expect(capture.displayName).toBe("Magewell HDMI");
			expect(capture.kind).toBe("hdmi");
		}
	});
});

describe("cerastream-backend.ts is untouched by this todo", () => {
	function git(args: string[], cwd: string): string {
		const proc = Bun.spawnSync(["git", ...args], { cwd });
		return new TextDecoder().decode(proc.stdout);
	}

	it("has no diff against the pre-sources.ts baseline (start choke point unmodified)", () => {
		const repoRoot = git(
			["rev-parse", "--show-toplevel"],
			process.cwd(),
		).trim();
		expect(repoRoot.length).toBeGreaterThan(0);

		const SOURCES_REL = "apps/backend/src/modules/streaming/sources.ts";
		const BACKEND_REL =
			"apps/backend/src/modules/streaming/cerastream-backend.ts";

		// baseline = the commit that ADDED sources.ts, minus one (this todo's parent
		// tree). Before that commit exists (initial local run), sources.ts is
		// untracked, so fall back to HEAD (working-tree vs the last commit).
		const addCommit = git(
			["log", "--diff-filter=A", "--format=%H", "-1", "--", SOURCES_REL],
			repoRoot,
		).trim();
		const baseline = addCommit.length > 0 ? `${addCommit}^` : "HEAD";

		const diff = git(["diff", baseline, "--", BACKEND_REL], repoRoot).trim();
		expect(diff).toBe("");
	});

	it("the start choke point still reads config.pipeline / selected_video_input and never imports the sources builder", async () => {
		const backend = await Bun.file(
			new URL("../modules/streaming/cerastream-backend.ts", import.meta.url),
		).text();
		expect(backend).toContain("config.pipeline ?? opts.pipeline");
		expect(backend).toContain(
			"config.selected_video_input ?? this.deps.getActiveInput()",
		);
		expect(backend).not.toContain("./sources.ts");
		expect(backend).not.toContain("buildSources");
	});
});
