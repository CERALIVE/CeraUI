import type {
	CaptureDevice,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveUvcH265Sources,
	summarizeProbedCaps,
} from "$lib/components/streaming/ValidationAdapter";

import {
	pipelinesFromSources,
	probedCapsFromSources,
	uvcH265SourcesFromSources,
} from "./sources-view-model";

const COARSE: StreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: false,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

const NETWORK: StreamSource = {
	origin: "network",
	id: "rtmp",
	pipelineId: "rtmp",
	labelKey: "settings.sources.rtmp",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "embedded",
	available: true,
	requiresGateway: "rtmp",
	url: null,
};

function capture(overrides: Partial<StreamSource> = {}): StreamSource {
	return {
		origin: "capture",
		id: "video0",
		pipelineId: "libuvch264",
		kind: "uvc_h264",
		displayName: "Elgato Cam Link",
		devicePath: "/dev/video0",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "none",
		available: true,
		...overrides,
	} as StreamSource;
}

function snapshot(sources: StreamSource[]): SourcesMessage {
	return { hardware: "rk3588", sources };
}

describe("pipelinesFromSources", () => {
	it("returns undefined for an unhydrated snapshot", () => {
		expect(pipelinesFromSources(undefined)).toBeUndefined();
	});

	it("projects the pipeline-level facets of every origin", () => {
		const pipelines = pipelinesFromSources(snapshot([COARSE, NETWORK]));

		expect(pipelines?.hdmi).toEqual({
			name: "hdmi",
			description: "hdmi",
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: false,
			defaultResolution: "1080p",
			defaultFramerate: 30,
			audio_kind: "selectable",
		});
		expect(pipelines?.rtmp?.requires_gateway).toBe("rtmp");
		expect(pipelines?.rtmp?.audio_kind).toBe("embedded");
		expect(pipelines?.hdmi?.requires_gateway).toBeUndefined();
	});

	it("keys capture rows by their bridged pipeline, collapsing duplicates", () => {
		const pipelines = pipelinesFromSources(
			snapshot([
				capture({ id: "video0", supportsAudio: true }),
				capture({ id: "video1", displayName: "Second cam" }),
			]),
		);

		expect(Object.keys(pipelines ?? {})).toEqual(["libuvch264"]);
		expect(pipelines?.libuvch264?.supportsAudio).toBe(true);
	});

	it("yields an empty registry for a hydrated snapshot with no sources", () => {
		expect(pipelinesFromSources(snapshot([]))).toEqual({});
	});
});

describe("probedCapsFromSources", () => {
	it("renders the labels the device-caps summary renders for the same formats", () => {
		const device: CaptureDevice = {
			input_id: "video0",
			display_name: "Elgato Cam Link",
			device_path: "/dev/video0",
			kind: "uvc_h264",
			media_class: "video",
			caps: [
				{
					width: 1920,
					height: 1080,
					framerate: "30/1",
					media_type: "video/x-h264",
				},
				{
					width: 1920,
					height: 1080,
					framerate: "60000/1001",
					media_type: "video/x-h264",
				},
			],
		} as CaptureDevice;
		const source = capture({
			modes: [
				{
					width: 1920,
					height: 1080,
					framerates: [30, 59.94],
					media_type: "video/x-h264",
				},
			],
		});

		expect(probedCapsFromSources(snapshot([source]))).toEqual(
			summarizeProbedCaps([device]),
		);
	});

	it("omits a capture row the engine enumerated no modes for", () => {
		expect(probedCapsFromSources(snapshot([capture(), COARSE]))).toEqual([]);
	});
});

describe("uvcH265SourcesFromSources", () => {
	it("offers a device whose per-format ladders advertise H.265", () => {
		const source = capture({
			id: "video2",
			kind: "uvc_h265",
			displayName: "H.265 cam",
			inputModes: [
				{
					inputMode: "uvc_h265",
					mediaType: "video/x-h265",
					pipelineId: "libuvch265",
					modes: [],
				},
			],
		});

		expect(uvcH265SourcesFromSources(snapshot([source]))).toEqual([
			{
				inputId: "video2",
				displayName: "H.265 cam",
				sourceKind: "uvc_h265",
			},
		]);
	});

	it("falls back to the folded modes on a pre-ladder engine", () => {
		const modes = [
			{
				width: 1920,
				height: 1080,
				framerates: [30],
				media_type: "video/x-h265",
			},
		];
		const device: CaptureDevice = {
			input_id: "video0",
			display_name: "Elgato Cam Link",
			device_path: "/dev/video0",
			kind: "uvc_h265",
			media_class: "video",
			caps: [
				{
					width: 1920,
					height: 1080,
					framerate: "30/1",
					media_type: "video/x-h265",
				},
			],
		} as CaptureDevice;

		expect(uvcH265SourcesFromSources(snapshot([capture({ modes })]))).toEqual(
			deriveUvcH265Sources([device]),
		);
	});

	it("does not offer a device that advertises no H.265 format", () => {
		expect(uvcH265SourcesFromSources(snapshot([capture(), NETWORK]))).toEqual(
			[],
		);
	});
});
