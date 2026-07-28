/*
 * One physical camera must be ONE remembered device, and a camera the engine is
 * holding open must not be reported as disconnected.
 *
 * Both defects were captured live on a Rock 5B+ running a DJI Osmo Pocket 3
 * (`uvc_h264` → `libuvch264`). `libuvch264src` drives its camera through libuvc,
 * i.e. usbfs, which unbinds the kernel `uvcvideo` driver — so every open/close
 * cycle makes `/dev/videoN` vanish and come back under a NEW number. Two things
 * followed:
 *
 *   1. `config.last_seen_devices` grew a NEW entry per renumber. The board's own
 *      file carried THREE entries — `/dev/video1`, `/dev/video2`, `/dev/video3`
 *      — under one identical `stableId`, rendering one camera as three rows.
 *   2. The rows were badged `Lost` / "Device disconnected" WHILE that camera was
 *      previewing, because the merge took device membership from CeraUI's own
 *      `/dev` scan — which cannot see a libuvc-held camera by construction —
 *      and discarded the engine's correct answer (cerastream PR #84/#86).
 *
 * Every rule below is keyed on the engine's `stableId` or on the device KIND.
 * The negative controls pin that: a device with no stable identity, and a device
 * of any other kind, keep their byte-identical previous behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ListDevicesResult } from "@ceralive/cerastream";
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
} from "@ceraui/rpc/schemas";

import type { LastSeenDevice } from "../helpers/config-schemas.ts";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { releasesV4l2Node } from "../modules/streaming/held-devices.ts";
import {
	buildSources,
	getEngineDeviceCache,
	getSessionSeenDeviceSnapshots,
	mergeObservedWithProbe,
	refreshEngineDeviceCache,
	refreshSourcesForHotplug,
	resetEngineDeviceCache,
	resolveSourceIdentity,
} from "../modules/streaming/sources.ts";
import { resolvePreviewStartFrame } from "../modules/ui/preview-proxy.ts";

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

const OSMO_STABLE_ID = "usb:2ca3:0023:DJI_DJIPocket3_123456789ABCDEF";
const RODE_STABLE_ID = "usb:19f7:0080:RODE_RODE_HDMI_to_USB-C_OC0001967";

const CAP_SOURCE_IDS = ["hdmi", "usb_mjpeg", "libuvch264", "test"] as const;

function capSources() {
	return CAP_SOURCE_IDS.map((id) => ({
		id,
		supports_audio: false,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	}));
}

function engineDevice(
	input_id: string,
	kind: DeviceKind,
	stable_id?: string,
): ListDevicesResult["devices"][number] {
	return {
		input_id,
		device_path: input_id,
		display_name: kind === "uvc_h264" ? "DJIPocket3: OsmoPocket3" : input_id,
		media_class: "video",
		kind,
		...(stable_id !== undefined ? { stable_id } : {}),
	} as ListDevicesResult["devices"][number];
}

function captureDevice(
	input_id: string,
	kind: DeviceKind,
	stable_id?: string,
): CaptureDevice {
	return {
		input_id,
		device_path: input_id,
		display_name: kind === "uvc_h264" ? "DJIPocket3: OsmoPocket3" : input_id,
		media_class: "video",
		kind,
		...(stable_id !== undefined ? { stable_id } : {}),
	};
}

function osmoSnapshot(id: string): LastSeenDevice {
	return {
		id,
		displayName: "DJIPocket3: OsmoPocket3",
		kind: "uvc_h264",
		pipelineId: "libuvch264",
		devicePath: id,
		stableId: OSMO_STABLE_ID,
	};
}

async function observe(devices: ListDevicesResult["devices"]): Promise<void> {
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () => ({ devices }),
	});
}

function resetState(): void {
	resetEngineDeviceCache();
	getConfig().last_seen_devices = [];
	delete getConfig().source;
}

describe("last_seen_devices — one entry per physical device", () => {
	beforeEach(resetState);
	afterEach(resetState);

	it("a camera that renumbers /dev/video1 → 2 → 3 updates ONE entry in place instead of appending three", async () => {
		for (const id of ["/dev/video1", "/dev/video2", "/dev/video3"]) {
			await observe([engineDevice(id, "uvc_h264", OSMO_STABLE_ID)]);
		}

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.id).toBe("/dev/video3");
		expect(persisted[0]?.devicePath).toBe("/dev/video3");
		expect(persisted[0]?.stableId).toBe(OSMO_STABLE_ID);
		expect(persisted[0]?.previousIds).toEqual(["/dev/video2", "/dev/video1"]);
	});

	it("self-heals a config that ALREADY carries the duplicates, with no manual edit", async () => {
		// The live board's exact corrupted state, verbatim in shape.
		getConfig().last_seen_devices = [
			{
				id: "/dev/video0",
				displayName: "HDMI Input",
				kind: "hdmi",
				pipelineId: "hdmi",
				devicePath: "/dev/video0",
				stableId: "port:fdee0000.hdmirx-controller",
			},
			osmoSnapshot("/dev/video1"),
			osmoSnapshot("/dev/video2"),
			osmoSnapshot("/dev/video3"),
		];

		await observe([engineDevice("/dev/video4", "mjpeg", RODE_STABLE_ID)]);

		const persisted = getConfig().last_seen_devices ?? [];
		const osmoRows = persisted.filter((d) => d.stableId === OSMO_STABLE_ID);
		expect(osmoRows).toHaveLength(1);
		expect(osmoRows[0]?.id).toBe("/dev/video1");
		expect(osmoRows[0]?.previousIds).toEqual(["/dev/video3", "/dev/video2"]);
		expect(persisted).toHaveLength(3);
	});

	it("NEGATIVE CONTROL — distinct stable identities are never folded together", async () => {
		await observe([
			engineDevice("/dev/video1", "uvc_h264", OSMO_STABLE_ID),
			engineDevice("/dev/video4", "mjpeg", RODE_STABLE_ID),
		]);

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted).toHaveLength(2);
		expect(persisted.every((d) => d.previousIds === undefined)).toBe(true);
	});

	it("NEGATIVE CONTROL — a device the engine gives NO stable id still keys on its node path", async () => {
		for (const id of ["/dev/video1", "/dev/video2", "/dev/video3"]) {
			await observe([engineDevice(id, "uvc_h264")]);
		}

		expect(getConfig().last_seen_devices ?? []).toHaveLength(3);
	});

	it("the retired node paths stay resolvable, so a stale config.source is not stranded by the fold", async () => {
		for (const id of ["/dev/video1", "/dev/video2"]) {
			await observe([engineDevice(id, "uvc_h264", OSMO_STABLE_ID)]);
		}
		const persisted = getConfig().last_seen_devices ?? [];

		const sources = buildSources({
			sources: capSources(),
			devices: [captureDevice("/dev/video2", "uvc_h264", OSMO_STABLE_ID)],
			networkIngest: NO_INGEST,
		});

		expect(resolveSourceIdentity("/dev/video1", sources, persisted)).toBe(
			"/dev/video2",
		);
	});

	it("previousIds round-trips through the persisted config schema", () => {
		const config = {
			...runtimeConfigSchema.parse({}),
			last_seen_devices: [
				{ ...osmoSnapshot("/dev/video3"), previousIds: ["/dev/video1"] },
			],
		};
		const parsed = runtimeConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.last_seen_devices?.[0]?.previousIds).toEqual([
				"/dev/video1",
			]);
		}
	});
});

describe("lost rows — a renumbered camera is one candidate, not one per path", () => {
	beforeEach(resetState);
	afterEach(resetState);

	it("three session-seen node paths for one camera synthesize EXACTLY one lost row", async () => {
		for (const id of ["/dev/video1", "/dev/video2", "/dev/video3"]) {
			await observe([engineDevice(id, "uvc_h264", OSMO_STABLE_ID)]);
		}
		expect(getSessionSeenDeviceSnapshots().size).toBe(3);

		const sources = buildSources({
			sources: capSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastSeenDevices: getConfig().last_seen_devices ?? [],
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});

		const osmoRows = sources.filter(
			(s) => s.origin === "capture" && s.pipelineId === "libuvch264",
		);
		expect(osmoRows).toHaveLength(1);
		expect(osmoRows[0]?.lost).toBe(true);
		expect(osmoRows[0]?.id).toBe("/dev/video3");
	});

	it("NEGATIVE CONTROL — two genuinely different cameras still yield two lost rows", async () => {
		await observe([
			engineDevice("/dev/video1", "uvc_h264", OSMO_STABLE_ID),
			engineDevice("/dev/video4", "mjpeg", RODE_STABLE_ID),
		]);

		const sources = buildSources({
			sources: capSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastSeenDevices: getConfig().last_seen_devices ?? [],
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});

		expect(sources.filter((s) => s.lost === true)).toHaveLength(2);
	});
});

/*
 * The preview leg used to be the ONE engine dispatch that skipped the identity
 * rule: `streaming.start` resolved `config.source` through `resolveSourceIdentity`,
 * while `PreviewCanvas` put the raw persisted path on its `start` frame and the
 * proxy forwarded it verbatim. On the board that meant de-authorizing the RØDE
 * renumbered the Osmo `/dev/video3` → `/dev/video2`, streaming still worked, and
 * preview answered `SourceUnavailable` 0/5 on a source the UI showed "Selected".
 */
describe("preview start — resolves to the CURRENT node, not the saved one", () => {
	beforeEach(resetState);
	afterEach(resetState);

	/** The production wiring: the SAME resolver `resolveSourceRouting` runs. */
	function previewResolver(
		sources: ReturnType<typeof buildSources>,
	): (id: string) => string {
		return (id) =>
			resolveSourceIdentity(id, sources, getConfig().last_seen_devices);
	}

	async function renumberFixture() {
		// Saved while the camera was /dev/video3; it now enumerates as /dev/video2.
		getConfig().last_seen_devices = [osmoSnapshot("/dev/video3")];
		getConfig().source = "/dev/video3";
		await observe([engineDevice("/dev/video2", "uvc_h264", OSMO_STABLE_ID)]);
		return buildSources({
			sources: capSources(),
			devices: [captureDevice("/dev/video2", "uvc_h264", OSMO_STABLE_ID)],
			networkIngest: NO_INGEST,
			lastSeenDevices: getConfig().last_seen_devices ?? [],
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});
	}

	it("the PREVIEW start frame carries /dev/video2 when the saved source is the stale /dev/video3", async () => {
		const sources = await renumberFixture();

		const sent = resolvePreviewStartFrame(
			JSON.stringify({
				action: "start",
				tier: "webcodecs",
				input_id: getConfig().source,
			}),
			previewResolver(sources),
		);

		expect(JSON.parse(sent as string)).toEqual({
			action: "start",
			tier: "webcodecs",
			input_id: "/dev/video2",
		});
	});

	it("the config self-heal persists the same migration the preview frame used", async () => {
		await renumberFixture();

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.id).toBe("/dev/video2");
		expect(persisted[0]?.previousIds).toEqual(["/dev/video3"]);
	});

	it("NEGATIVE CONTROL — a TRUE unplug keeps its id AND its lost row (no over-resolution)", async () => {
		await observe([engineDevice("/dev/video1", "uvc_h264", OSMO_STABLE_ID)]);
		getConfig().source = "/dev/video1";

		// The camera is genuinely gone: nothing live shares its stable identity.
		const sources = buildSources({
			sources: capSources(),
			devices: [captureDevice("/dev/video0", "hdmi")],
			networkIngest: NO_INGEST,
			lastSeenDevices: getConfig().last_seen_devices ?? [],
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});

		expect(sources.find((s) => s.id === "/dev/video1")?.lost).toBe(true);

		const frame = JSON.stringify({
			action: "start",
			tier: "webcodecs",
			input_id: "/dev/video1",
		});
		// Byte-identical passthrough — the engine still answers source-unavailable.
		expect(resolvePreviewStartFrame(frame, previewResolver(sources))).toBe(
			frame,
		);
	});

	it("NEGATIVE CONTROL — a DIFFERENT camera that took the freed node is never adopted", async () => {
		getConfig().last_seen_devices = [osmoSnapshot("/dev/video3")];

		const sources = buildSources({
			sources: capSources(),
			devices: [captureDevice("/dev/video2", "mjpeg", RODE_STABLE_ID)],
			networkIngest: NO_INGEST,
			lastSeenDevices: getConfig().last_seen_devices ?? [],
		});

		const frame = JSON.stringify({ action: "start", input_id: "/dev/video3" });
		expect(resolvePreviewStartFrame(frame, previewResolver(sources))).toBe(
			frame,
		);
	});

	it("leaves every frame that is not a resolvable start frame untouched", () => {
		const resolve = () => "/dev/videoX";
		const binary = new Uint8Array([1, 2, 3]).buffer;

		expect(resolvePreviewStartFrame(binary, resolve)).toBe(binary);
		for (const frame of [
			JSON.stringify({ action: "stop" }),
			JSON.stringify({ action: "start", tier: "mse" }),
			JSON.stringify({ action: "start", input_id: "" }),
			JSON.stringify({ type: "webrtc-ice", candidate: "x" }),
			JSON.stringify(["not", "an", "object"]),
			"not json at all",
		]) {
			expect(resolvePreviewStartFrame(frame, resolve)).toBe(frame);
		}
	});
});

describe("held devices — the /dev scan is not a presence oracle for a libuvc camera", () => {
	beforeEach(resetState);
	afterEach(resetState);

	it("releasesV4l2Node is scoped to the libuvc-driven kinds and nothing else", () => {
		expect(releasesV4l2Node("uvc_h264")).toBe(true);
		expect(releasesV4l2Node("uvc_h265")).toBe(true);
		for (const kind of [
			"hdmi",
			"mjpeg",
			"camlink",
			"test",
			"network",
			"audio",
			"usb",
			"other",
		] as DeviceKind[]) {
			expect(releasesV4l2Node(kind)).toBe(false);
		}
		expect(releasesV4l2Node(undefined)).toBe(false);
	});

	it("mergeObservedWithProbe keeps a probe-listed UVC camera the /dev scan cannot see", () => {
		const merged = mergeObservedWithProbe(
			[captureDevice("/dev/video0", "hdmi")],
			[
				captureDevice("/dev/video0", "hdmi"),
				captureDevice("/dev/video1", "uvc_h264", OSMO_STABLE_ID),
			],
		);
		expect(merged.map((d) => d.input_id)).toEqual([
			"/dev/video0",
			"/dev/video1",
		]);
	});

	it("NEGATIVE CONTROL — a probe-listed device of any OTHER kind is still dropped when the scan no longer sees it", () => {
		const merged = mergeObservedWithProbe(
			[captureDevice("/dev/video0", "hdmi")],
			[
				captureDevice("/dev/video0", "hdmi"),
				captureDevice("/dev/video4", "mjpeg", RODE_STABLE_ID),
			],
		);
		expect(merged.map((d) => d.input_id)).toEqual(["/dev/video0"]);
	});

	it("a camera the engine is holding open renders LIVE, not lost, on a hotplug rebuild", async () => {
		await observe([engineDevice("/dev/video1", "uvc_h264", OSMO_STABLE_ID)]);

		// The engine still reports the held camera; CeraUI's own scan cannot —
		// libuvc has unbound uvcvideo for the duration of the preview.
		await refreshSourcesForHotplug([captureDevice("/dev/video0", "hdmi")], {
			fetchEngineDevices: async () => ({
				devices: [
					engineDevice("/dev/video0", "hdmi"),
					engineDevice("/dev/video1", "uvc_h264", OSMO_STABLE_ID),
				],
			}),
		});

		const sources = buildSources({
			sources: capSources(),
			devices: getEngineDeviceCache(),
			networkIngest: NO_INGEST,
			lastSeenDevices: getConfig().last_seen_devices ?? [],
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});

		const osmo = sources.find((s) => s.id === "/dev/video1");
		expect(osmo?.lost).toBeUndefined();
		expect(osmo?.available).toBe(true);
	});
});
