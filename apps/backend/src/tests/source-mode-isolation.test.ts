import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { fromEngineDevice } from "../modules/streaming/devices.ts";
import {
	buildSources,
	deriveEngineRouting,
	getSourcesMessage,
} from "../modules/streaming/sources.ts";
import {
	SECOND_CAMERA,
	SECOND_STABLE,
} from "./helpers/applied-source-selection.ts";
import { captureSelectionFixture } from "./helpers/capture-selection-clears.ts";
import { osmo } from "./helpers/dual-mode-camera.ts";

test("only selected camera A inherits saved MJPEG while dual-format B keeps its own default", async () => {
	const f = await captureSelectionFixture();
	const rows = f.sources().filter((row) => row.origin === "capture");
	const a = rows.find((row) => row.id === "video1");
	const b = rows.find((row) => row.id === "video2");

	expect(a?.selectedInputMode).toBe("mjpeg");
	expect(b?.selectedInputMode).toBe("uvc_h264");
	expect(deriveEngineRouting("video1", rows)).toEqual({
		pipeline: "usb_mjpeg",
		selected_video_input: "video1",
	});
	expect(deriveEngineRouting("video2", rows)).toEqual({
		pipeline: "libuvch264",
		selected_video_input: "video2",
	});
	// Exercise the production builder caller, not only a supplied build context.
	const broadcast = getSourcesMessage().sources.filter(
		(row) => row.origin === "capture",
	);
	expect(broadcast.find((row) => row.id === "video1")?.selectedInputMode).toBe(
		"mjpeg",
	);
	expect(broadcast.find((row) => row.id === "video2")?.selectedInputMode).toBe(
		"uvc_h264",
	);
});

test("the selection anchor carries A's explicit pick across re-enumeration and a reused path", async () => {
	const f = await captureSelectionFixture();
	f.devices.splice(
		0,
		2,
		{ ...SECOND_CAMERA, input_id: "video1" },
		osmo("video7"),
	);

	const rows = f.sources().filter((row) => row.origin === "capture");

	expect(rows.find((row) => row.id === "video7")?.selectedInputMode).toBe(
		"mjpeg",
	);
	expect(rows.find((row) => row.id === "video1")?.selectedInputMode).toBe(
		"uvc_h264",
	);
	expect(deriveEngineRouting("video7", rows)?.pipeline).toBe("usb_mjpeg");
});

test("an absent selected identity cannot lend its mode to the device that took its node", async () => {
	const f = await captureSelectionFixture();
	f.devices.splice(0, 2, { ...SECOND_CAMERA, input_id: "video1" });
	getConfig().last_streamed_source = "video1";
	getConfig().last_streamed_source_stable_id = SECOND_STABLE;

	expect(
		f
			.sources()
			.filter((row) => row.origin === "capture")
			.find((row) => row.id === "video1")?.selectedInputMode,
	).toBe("uvc_h264");
});

test("last streamed camera B cannot override the current selection of camera A", async () => {
	const f = await captureSelectionFixture();
	getConfig().last_streamed_source = "video2";
	getConfig().last_streamed_source_stable_id = SECOND_STABLE;

	const rows = f.sources().filter((row) => row.origin === "capture");
	expect(rows.find((row) => row.id === "video1")?.selectedInputMode).toBe(
		"mjpeg",
	);
	expect(rows.find((row) => row.id === "video2")?.selectedInputMode).toBe(
		"uvc_h264",
	);
});

test("missing per-device modes never invents a selector from saved or global formats", async () => {
	const f = await captureSelectionFixture();
	f.devices.splice(0, 1, { ...osmo(), modes: undefined });

	const row = f
		.sources()
		.filter((entry) => entry.origin === "capture")
		.find((entry) => entry.id === "video1");

	expect(row?.inputModes).toBeUndefined();
	expect(row?.selectedInputMode).toBeUndefined();
	expect(deriveEngineRouting("video1", f.sources())?.pipeline).toBe(
		"libuvch264",
	);
});

test("a legacy device without a kind contributes no invented capture selector", async () => {
	const f = await captureSelectionFixture();
	const rows = buildSources({
		sources: f.capabilities.caps.sources,
		devices: [
			fromEngineDevice({
				input_id: "video1",
				device_path: "/dev/video1",
				display_name: "USB camera",
				media_class: "video",
			}),
		],
		networkIngest: f.networkIngest,
		inputMode: "mjpeg",
	});
	expect(rows.filter((row) => row.origin === "capture")).toEqual([]);
});
