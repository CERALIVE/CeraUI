import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import {
	getEffectiveHardware,
	getPipelineList,
	initPipelines,
	searchPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";

// Source lists differ per hardware. The registry is now derived from the
// capability contract; the default (table-derived) contract mirrors the
// pipeline-sources.ts parity tables MINUS decklink, which is dropped on every
// board (no cerastream support):
//   jetson : camlink, libuvch264, v4l_mjpeg, rtmp, srt, test
//   n100   : libuvch264, v4l_mjpeg, rtmp, test
// "camlink" and "srt" are jetson-only — the jetson↔n100 discriminators.

describe("pipeline registry recompute on hardware switch", () => {
	beforeEach(async () => {
		// Establish a deterministic jetson baseline regardless of setup.hw.
		setMockHardware("jetson");
		await initPipelines();
	});

	afterAll(async () => {
		// Restore the default device hardware so we don't pollute other tests.
		setMockHardware("rk3588");
		await initPipelines();
	});

	it("reflects the new hardware's sources after a hardware switch", async () => {
		// Sanity: jetson baseline is loaded; decklink is dropped on every board.
		expect(searchPipelines("camlink")).not.toBeNull();
		expect(searchPipelines("decklink")).toBeNull();

		const ok = setMockHardware("n100");
		expect(ok).toBe(true);
		await initPipelines();
		expect(getEffectiveHardware()).toBe("n100");

		// Registry must now reflect n100, not the stale jetson list.
		expect(searchPipelines("libuvch264")).not.toBeNull();
		expect(searchPipelines("camlink")).toBeNull();
		expect(searchPipelines("srt")).toBeNull();
		// Decklink stays dropped on n100 (no engine support).
		expect(searchPipelines("decklink")).toBeNull();
	});

	it("updates getPipelineList() to the new hardware after switch", async () => {
		setMockHardware("n100");
		await initPipelines();

		const list = getPipelineList();
		expect(Object.keys(list)).toContain("libuvch264");
		expect(Object.keys(list)).not.toContain("camlink");
		expect(Object.keys(list)).not.toContain("decklink");
	});

	it("tags returned pipelines with the switched hardware", async () => {
		setMockHardware("n100");
		await initPipelines();

		const libuvch264 = searchPipelines("libuvch264");
		expect(libuvch264).not.toBeNull();
		expect(libuvch264?.hardware).toBe("n100");
	});
});
