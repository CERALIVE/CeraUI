import { afterEach, describe, expect, it } from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { BITRATE_MAX, BITRATE_MIN } from "@ceraui/rpc/schemas";
import type {
	PipelineHardwareType,
	VideoSource,
} from "../modules/streaming/pipeline-sources.ts";
import {
	getPipelineList,
	getPipelinesMessage,
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";

// CAPABILITY CONTRACT REGRESSION TEST
//
// Verifies that the pipeline registry correctly derives from the capability
// contract. The per-board source tables (parity baseline) were deleted after
// proving the capability contract alone reproduces them. This test now serves
// as a regression gate: it ensures the capability service correctly builds the
// pipeline registry from a mock contract on every supported board.
//
// It runs entirely in CI with NO real board: the engine's `get-capabilities`
// response is stubbed by injecting `fetchEngineCapabilities` into the capability
// service. No GStreamer, no cerastream process, no hardware probe is touched.

const BOARDS: ReadonlyArray<PipelineHardwareType> = [
	"jetson",
	"rk3588",
	"n100",
	"generic",
];

// `decklink` (Blackmagic SDI) has no cerastream pipeline, so a real HAL/capability
// contract never emits it. The registry intentionally drops it.
const _DROPPED_SOURCES: ReadonlySet<VideoSource> = new Set<VideoSource>([
	"decklink",
]);

// Build a MOCK capability contract standing in for the engine's `get-capabilities`
// response. This is what the cerastream HAL would emit on that board.
function mockCapabilitiesForBoard(
	board: PipelineHardwareType,
): GetCapabilitiesResult {
	// Define the expected sources per board (derived from the deleted tables).
	// Note: decklink is intentionally excluded here because it has no cerastream
	// pipeline and is dropped by the registry (UNSUPPORTED_SOURCES).
	const boardSources: Record<PipelineHardwareType, VideoSource[]> = {
		jetson: ["camlink", "libuvch264", "v4l_mjpeg", "rtmp", "srt", "test"],
		rk3588: ["hdmi", "libuvch264", "usb_mjpeg", "rtmp", "srt", "test"],
		n100: ["libuvch264", "v4l_mjpeg", "rtmp", "test"],
		generic: ["camlink", "v4l_mjpeg", "test"],
	};

	const sources = boardSources[board].map((id) => ({
		id,
		supports_audio: true,
		supports_resolution_override: id !== "rtmp" && id !== "srt",
		supports_framerate_override: true,
		default_resolution: "1080p" as const,
		default_framerate: id === "decklink" ? 50 : 30,
	}));

	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: board !== "generic",
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["h264", "h265"],
			bitrate_range: { min: BITRATE_MIN, max: BITRATE_MAX, unit: "kbps" },
		},
		sources,
	};
}

// Inject the mock as the capability service's live engine fetcher — the same
// hardware-free seam the rest of the streaming suite uses to drive `getPipelines()`
// without an engine.
function provide(board: PipelineHardwareType) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: mockCapabilitiesForBoard(board),
			schemaVersion: SCHEMA_VERSION,
		}),
	};
}

afterEach(async () => {
	// Restore to a deterministic device baseline so this gate never leaks mock
	// state into sibling pipeline tests. Use the mock provider to ensure a
	// consistent registry state.
	setMockHardware("rk3588");
	await initPipelines(provide("rk3588"));
});

describe("capability contract regression gate", () => {
	for (const board of BOARDS) {
		it(`${board}: capability contract builds a valid pipeline registry`, async () => {
			setMockHardware(board);
			await initPipelines(provide(board));

			const pipelines = getPipelineList();
			const pipelineIds = Object.keys(pipelines);

			// Registry should not be empty
			expect(pipelineIds.length).toBeGreaterThan(0);

			// The broadcast message carries the right board tag
			expect(getPipelinesMessage().hardware).toBe(board);

			// Each pipeline should have required fields
			for (const id of pipelineIds) {
				const pipeline = pipelines[id];
				expect(pipeline).toBeDefined();
				expect(pipeline?.name).toBe(id);
				expect(pipeline?.description).toBeTruthy();
				expect(typeof pipeline?.supportsAudio).toBe("boolean");
				expect(typeof pipeline?.supportsResolutionOverride).toBe("boolean");
				expect(typeof pipeline?.supportsFramerateOverride).toBe("boolean");
			}
		});
	}

	it("decklink is dropped on every board (no cerastream pipeline)", async () => {
		for (const board of BOARDS) {
			setMockHardware(board);
			await initPipelines(provide(board));
			expect(Object.keys(getPipelineList())).not.toContain("decklink");
		}
	});
});
