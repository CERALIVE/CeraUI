/*
 * Load-time clamp of an already-invalid persisted config (device-quality-wave3
 * todo 11b).
 *
 * Todo 11a stops a bad {resolution, framerate} pairing being WRITTEN. It does
 * nothing for the fleet that already has one on disk — a device that persisted
 * 1080p60 against an H.264 ladder topping out at 30 keeps re-sending it on every
 * start and keeps failing `not-negotiated`, forever, with no operator signal.
 *
 * So the persisted pairing is reconciled against the engine's reported ladder the
 * moment that ladder is first known (the `sources` list is built), clamped DOWN
 * to the nearest mode the device actually enumerates, and the operator is told
 * ONCE with a keyed notification. The fixture is the effort's running example: a
 * DJI Osmo Pocket 3 whose H.264 ladder reaches 1080p30 while 60 exists only at
 * 720p (and only MJPEG reaches 1080p60).
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type {
	CaptureCap,
	CaptureDevice,
	DeviceKind,
} from "@ceraui/rpc/schemas";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	CLAMPED_MODE_NOTIFICATION,
	reconcilePersistedDeviceMode,
	resetPersistedDeviceModeClamp,
} from "../modules/streaming/persisted-mode-clamp.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	applyObservedEngineDevices,
	getSourcesMessage,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

type SourceCap = GetCapabilitiesResult["sources"][number];

function source(id: string): SourceCap {
	return {
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	};
}

const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		source("hdmi"),
		source("libuvch264"),
		source("usb_mjpeg"),
		source("test"),
	],
};

function provide() {
	return {
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

function cap(
	width: number,
	height: number,
	framerate: string,
	media_type?: string,
): CaptureCap {
	return {
		width,
		height,
		framerate,
		...(media_type !== undefined ? { media_type } : {}),
	};
}

function device(
	input_id: string,
	kind: DeviceKind,
	caps: CaptureCap[],
): CaptureDevice {
	return {
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: input_id,
		media_class: "video",
		kind,
		caps,
	};
}

/** The Osmo 1080p60 fixture: 60 exists, but never at 1080p on the H.264 ladder. */
const OSMO_H264 = device("video1", "uvc_h264", [
	cap(1920, 1080, "30/1", "video/x-h264"),
	cap(1280, 720, "30/1", "video/x-h264"),
	cap(1280, 720, "60/1", "video/x-h264"),
	cap(1920, 1080, "30/1", "image/jpeg"),
	cap(1920, 1080, "60/1", "image/jpeg"),
	cap(3840, 2160, "30/1", "image/jpeg"),
]);

/** The same hardware selected as MJPEG — 1080p60 is genuinely deliverable. */
const OSMO_MJPEG = device("video2", "mjpeg", [
	cap(1920, 1080, "60/1", "image/jpeg"),
	cap(3840, 2160, "30/1", "image/jpeg"),
]);

interface Sent {
	name: string;
	key: string | undefined;
	params: Record<string, unknown> | undefined;
}

function collector() {
	const sent: Sent[] = [];
	return {
		sent,
		notify: ((
			name: string,
			_type: unknown,
			_msg: unknown,
			_duration?: unknown,
			_persistent?: unknown,
			_dismissable?: unknown,
			_authedOnly?: unknown,
			key?: string,
			params?: Record<string, unknown>,
		) => {
			sent.push({ name, key, params });
		}) as never,
	};
}

function seedPersisted(source: string, resolution: string, framerate: number) {
	const config = getConfig();
	config.source = source;
	config.selected_video_input = source;
	config.resolution = resolution as never;
	config.framerate = framerate as never;
}

describe("persisted device-mode clamp (todo 11b)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	let prior: ReturnType<typeof getConfig> | undefined;
	let priorSource: string | undefined;
	let priorResolution: ReturnType<typeof getConfig>["resolution"];
	let priorFramerate: ReturnType<typeof getConfig>["framerate"];
	let priorSelected: string | undefined;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide());
	});
	beforeEach(() => {
		prior = getConfig();
		priorSource = prior.source;
		priorResolution = prior.resolution;
		priorFramerate = prior.framerate;
		priorSelected = prior.selected_video_input;
		resetEngineDeviceCache();
		resetPersistedDeviceModeClamp();
	});
	afterEach(() => {
		const config = getConfig();
		config.source = priorSource;
		config.resolution = priorResolution;
		config.framerate = priorFramerate;
		config.selected_video_input = priorSelected;
		resetEngineDeviceCache();
		resetPersistedDeviceModeClamp();
	});
	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		await initPipelines();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	test("a persisted 1080p60 on the Osmo H.264 ladder clamps to 1080p30", () => {
		applyObservedEngineDevices([OSMO_H264]);
		seedPersisted("video1", "1080p", 60);
		const { sent, notify } = collector();

		const clamped = reconcilePersistedDeviceMode(getSourcesMessage().sources, {
			notify,
			persist: () => {},
		});

		expect(clamped).toBe(true);
		const config = getConfig();
		expect(config.resolution).toBe("1080p");
		expect(config.framerate).toBe(30);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.name).toBe(CLAMPED_MODE_NOTIFICATION);
		expect(sent[0]?.key).toBe("notifications.encoderModeClamped");
		expect(sent[0]?.params).toEqual({
			resolution: "1080p",
			framerate: 30,
			previousResolution: "1080p",
			previousFramerate: 60,
		});
	});

	test("the clamp NEVER invents a pairing — 2160p60 lands on a real Osmo mode", () => {
		applyObservedEngineDevices([OSMO_H264]);
		seedPersisted("video1", "2160p", 60);
		const { notify } = collector();

		reconcilePersistedDeviceMode(getSourcesMessage().sources, {
			notify,
			persist: () => {},
		});

		const config = getConfig();
		// 2160p is MJPEG-only on this device, so the H.264 ladder tops out at 1080p30.
		expect(config.resolution).toBe("1080p");
		expect(config.framerate).toBe(30);
	});

	test("the notification is ONE-TIME — a re-run after the clamp is silent", () => {
		applyObservedEngineDevices([OSMO_H264]);
		seedPersisted("video1", "1080p", 60);
		const { sent, notify } = collector();

		reconcilePersistedDeviceMode(getSourcesMessage().sources, {
			notify,
			persist: () => {},
		});
		const second = reconcilePersistedDeviceMode(getSourcesMessage().sources, {
			notify,
			persist: () => {},
		});

		expect(second).toBe(false);
		expect(sent).toHaveLength(1);
	});

	test("a VALID persisted config is left untouched and silent", () => {
		applyObservedEngineDevices([OSMO_H264]);
		seedPersisted("video1", "720p", 60);
		const { sent, notify } = collector();

		const clamped = reconcilePersistedDeviceMode(getSourcesMessage().sources, {
			notify,
			persist: () => {},
		});

		expect(clamped).toBe(false);
		expect(getConfig().resolution).toBe("720p");
		expect(getConfig().framerate).toBe(60);
		expect(sent).toHaveLength(0);
	});

	test("the SAME pairing on the MJPEG ladder is valid and never clamps", () => {
		applyObservedEngineDevices([OSMO_MJPEG]);
		seedPersisted("video2", "1080p", 60);
		const { sent, notify } = collector();

		expect(
			reconcilePersistedDeviceMode(getSourcesMessage().sources, {
				notify,
				persist: () => {},
			}),
		).toBe(false);
		expect(getConfig().framerate).toBe(60);
		expect(sent).toHaveLength(0);
	});

	test("no reported ladder never clamps — an unknown must not subtract", () => {
		applyObservedEngineDevices([device("video3", "uvc_h264", [])]);
		seedPersisted("video3", "2160p", 60);
		const { sent, notify } = collector();

		expect(
			reconcilePersistedDeviceMode(getSourcesMessage().sources, {
				notify,
				persist: () => {},
			}),
		).toBe(false);
		expect(getConfig().resolution).toBe("2160p");
		expect(sent).toHaveLength(0);
	});

	test("the clamp persists through the injected write seam", () => {
		applyObservedEngineDevices([OSMO_H264]);
		seedPersisted("video1", "1080p", 60);
		const { notify } = collector();
		let persisted = 0;

		reconcilePersistedDeviceMode(getSourcesMessage().sources, {
			notify,
			persist: () => {
				persisted += 1;
			},
		});

		expect(persisted).toBe(1);
		expect(prior).toBeDefined();
	});
});
