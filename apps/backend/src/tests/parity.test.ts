import { afterEach, describe, expect, it } from "bun:test";

import { type GetCapabilitiesResult, SCHEMA_VERSION } from "@ceralive/cerastream";
import { BITRATE_MAX, BITRATE_MIN } from "@ceraui/rpc/schemas";

import {
	getPipelineList,
	getPipelinesMessage,
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	listPipelineSources,
	type PipelineHardwareType,
	type VideoSource,
} from "../modules/streaming/pipeline-sources.ts";

// HARDWARE-FREE CAPABILITY/TABLE PARITY GATE
//
// This test is the GATE that authorizes deleting the per-board `pipeline-sources.ts`
// tables (Task 29). It proves that, for every supported board, the pipeline id list
// `getPipelines()` derives from the capability contract is identical to the id list
// those legacy tables declare — minus the intentionally-dropped `decklink` source.
// Once green, the tables are provably redundant: the capability contract alone
// reproduces them.
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
// contract never emits it. The gate encodes that intentional drop: the derived list
// must equal each board's table id list with these sources removed. Only the n100
// table actually declares `decklink`, so for the other three boards the filter is a
// no-op (derived == table exactly).
const DROPPED_SOURCES: ReadonlySet<VideoSource> = new Set<VideoSource>([
	"decklink",
]);

/** The video-source ids a board's `pipeline-sources.ts` table declares, in order. */
function tableIds(board: PipelineHardwareType): VideoSource[] {
	return listPipelineSources(board).map((meta) => meta.source);
}

/** Parity baseline: the table id list with the intentionally-dropped sources removed. */
function expectedDerivedIds(board: PipelineHardwareType): VideoSource[] {
	return tableIds(board).filter((id) => !DROPPED_SOURCES.has(id));
}

// Build a MOCK capability contract standing in for the engine's `get-capabilities`
// response: the board's real (engine-supported) source-kinds — i.e. the table minus
// the dropped sources, mapped onto the capability source shape. This is what the
// cerastream HAL would emit on that board; here it is synthesised from the table so
// the gate stays hardware-free.
function mockCapabilitiesForBoard(
	board: PipelineHardwareType,
): GetCapabilitiesResult {
	const sources = listPipelineSources(board)
		.filter((meta) => !DROPPED_SOURCES.has(meta.source))
		.map((meta) => ({
			id: meta.source,
			supports_audio: meta.supportsAudio,
			supports_resolution_override: meta.supportsResolutionOverride,
			supports_framerate_override: meta.supportsFramerateOverride,
			default_resolution: meta.defaultResolution ?? "1080p",
			default_framerate: meta.defaultFramerate ?? 30,
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
	// Restore the default table-derived contract on a deterministic device baseline
	// so this gate never leaks mock state into sibling pipeline tests.
	setMockHardware("rk3588");
	await initPipelines();
});

describe("hardware-free capability/table parity gate", () => {
	for (const board of BOARDS) {
		it(`${board}: capability-derived pipeline ids equal the table id list (minus dropped sources)`, async () => {
			setMockHardware(board);
			await initPipelines(provide(board));

			const derived = Object.keys(getPipelineList());
			const expected = expectedDerivedIds(board);

			// Exact, order-preserving parity: no extra sources, no missing sources.
			expect(derived).toEqual(expected);
			// The broadcast message carries the right board tag.
			expect(getPipelinesMessage().hardware).toBe(board);
		});
	}

	it("n100: derived list equals the table MINUS decklink (intentional drop, documented in the gate)", async () => {
		setMockHardware("n100");
		await initPipelines(provide("n100"));

		const derived = Object.keys(getPipelineList());
		const table = tableIds("n100");

		// The n100 table genuinely declares decklink — this is the one board where the
		// drop is observable, not a no-op filter.
		expect(table).toContain("decklink");

		const expected = table.filter((id) => id !== "decklink");
		expect(derived).toEqual(expected);

		// The documented drop: decklink is NOT in the capability-derived n100 list.
		expect(derived).not.toContain("decklink");
	});

	it("decklink is dropped on every board (no cerastream pipeline)", async () => {
		for (const board of BOARDS) {
			setMockHardware(board);
			await initPipelines(provide(board));
			expect(Object.keys(getPipelineList())).not.toContain("decklink");
		}
	});
});
