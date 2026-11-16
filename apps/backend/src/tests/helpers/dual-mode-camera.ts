import type {
	CaptureCap,
	CaptureDevice,
	CaptureMode,
} from "@ceraui/rpc/schemas";

import { fromEngineDevice } from "../../modules/streaming/devices.ts";

export function cap(
	width: number,
	height: number,
	framerate: string,
	media_type: string,
): CaptureCap {
	return { width, height, framerate, media_type };
}

export const H264 = "video/x-h264";
export const MJPEG = "image/jpeg";

/**
 * The board's running example: a DJI Osmo Pocket 3. Its H.264 ladder tops out at
 * 1080p30 while its MJPEG ladder reaches 1080p60 and 2160p30 — so the two
 * genuinely disagree and a union is observably wrong in both directions.
 */
export const OSMO_MODES: CaptureMode[] = [
	{
		media_type: H264,
		pipeline_kind: "uvc_h264",
		caps: [
			cap(1920, 1080, "30/1", H264),
			cap(1280, 720, "60/1", H264),
			cap(1280, 720, "30/1", H264),
		],
	},
	{
		media_type: MJPEG,
		pipeline_kind: "mjpeg",
		caps: [
			cap(1920, 1080, "60/1", MJPEG),
			cap(1920, 1080, "30/1", MJPEG),
			cap(3840, 2160, "30/1", MJPEG),
		],
	},
];

export function engineDevice(
	input_id: string,
	kind: NonNullable<Parameters<typeof fromEngineDevice>[0]["kind"]>,
	modes: CaptureMode[],
	displayName: string,
	stableId: string,
): CaptureDevice {
	return fromEngineDevice({
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: displayName,
		media_class: "video",
		kind,
		caps: modes.flatMap((mode) => mode.caps),
		modes,
		stable_id: stableId,
	});
}

export const OSMO_STABLE = "usb:2ca3:0023:OSMO";

export function osmo(inputId = "video1"): CaptureDevice {
	return engineDevice(
		inputId,
		"uvc_h264",
		OSMO_MODES,
		"DJIPocket3: OsmoPocket3",
		OSMO_STABLE,
	);
}
