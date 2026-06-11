import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import {
	getEffectiveHardware,
	getPipelineList,
	initPipelines,
	searchPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";

// Source lists differ per hardware (pipeline-sources.ts tables):
//   jetson : camlink, libuvch264, v4l_mjpeg, rtmp, srt, test
//   n100   : libuvch264, v4l_mjpeg, decklink, rtmp, test
// "camlink" is jetson-only, "decklink" is n100-only — ideal discriminators.

describe("pipeline registry recompute on hardware switch", () => {
	beforeEach(() => {
		// Establish a deterministic jetson baseline regardless of setup.hw.
		setMockHardware("jetson");
		initPipelines();
	});

	afterAll(() => {
		// Restore the default device hardware so we don't pollute other tests.
		setMockHardware("rk3588");
		initPipelines();
	});

	it("reflects the new hardware's sources after setMockHardware", () => {
		// Sanity: jetson baseline is loaded.
		expect(searchPipelines("camlink")).not.toBeNull();
		expect(searchPipelines("decklink")).toBeNull();

		// Switch to a different hardware type.
		const ok = setMockHardware("n100");
		expect(ok).toBe(true);
		expect(getEffectiveHardware()).toBe("n100");

		// Registry must now reflect n100, not the stale jetson list.
		expect(searchPipelines("decklink")).not.toBeNull();
		expect(searchPipelines("camlink")).toBeNull();
	});

	it("updates getPipelineList() to the new hardware after switch", () => {
		setMockHardware("n100");

		const list = getPipelineList();
		expect(Object.keys(list)).toContain("decklink");
		expect(Object.keys(list)).not.toContain("camlink");
	});

	it("tags returned pipelines with the switched hardware", () => {
		setMockHardware("n100");

		const decklink = searchPipelines("decklink");
		expect(decklink).not.toBeNull();
		expect(decklink?.hardware).toBe("n100");
	});
});
