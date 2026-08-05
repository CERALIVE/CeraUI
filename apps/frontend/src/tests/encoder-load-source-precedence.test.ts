// @vitest-environment jsdom
/**
 * Where the panel's per-core encoder reading comes from.
 *
 * The device's own collector is `isRealDevice()`-gated on the backend, so on a
 * dev host the `encoder-load` broadcast simply never arrives and the fixture is
 * reached; on hardware a frame always arrives and must win. The seam is that
 * ABSENCE, not a build flag — so the assertions below are about precedence, and
 * the one that matters most is that a device saying "neither interface exists"
 * still beats a fixture that would happily draw bars.
 */

import type { EncoderLoad } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const feed = {
	encoderLoad: undefined as EncoderLoad | undefined,
	streaming: true,
};

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getDeviceStats: () => undefined,
	getEncoderLoadSnapshot: () => feed.encoderLoad,
	getIsStreaming: () => feed.streaming,
	getSensors: () => undefined,
}));

const VENDOR_FRAME: EncoderLoad = {
	source: "mpp-service",
	cores: [
		{ core: "rkvenc0", kind: "percent", percent: 11.34 },
		{ core: "rkvenc1", kind: "percent", percent: 0 },
	],
	updatedAt: 1_800_000_000_000,
	simulated: false,
};

const MAINLINE_FRAME: EncoderLoad = {
	source: "clk-enable-count",
	cores: [
		{ core: "rkvenc0", kind: "active", active: true },
		{ core: "rkvenc1", kind: "active", active: true },
	],
	updatedAt: 1_800_000_000_000,
	simulated: false,
};

const DEVICE_SAYS_NOTHING_READABLE: EncoderLoad = {
	source: null,
	cores: [],
	updatedAt: null,
	simulated: false,
};

async function readEncoderLoad() {
	const store = await import("$lib/stores/device-health-history.svelte");
	store.initDeviceHealthHistory();
	return store.getEncoderLoad();
}

afterEach(async () => {
	const store = await import("$lib/stores/device-health-history.svelte");
	store.destroyDeviceHealthHistory();
	feed.encoderLoad = undefined;
	feed.streaming = true;
	vi.resetModules();
});

beforeEach(() => {
	vi.resetModules();
});

describe("a real device reading always wins", () => {
	it("serves the vendor kernel's measured percentages verbatim", async () => {
		feed.encoderLoad = VENDOR_FRAME;
		expect(await readEncoderLoad()).toEqual(VENDOR_FRAME);
	});

	it("serves the mainline kernel's busy/idle bit, with no percent field", async () => {
		feed.encoderLoad = MAINLINE_FRAME;
		const reading = await readEncoderLoad();
		expect(reading.source).toBe("clk-enable-count");
		for (const core of reading.cores) {
			expect(core).not.toHaveProperty("percent");
		}
	});

	it("a device that reads NOTHING still beats the fixture", async () => {
		// The whole point: the fixture is a dev convenience, never a stand-in for
		// a device that has actually answered the question.
		feed.encoderLoad = DEVICE_SAYS_NOTHING_READABLE;
		expect(await readEncoderLoad()).toEqual(DEVICE_SAYS_NOTHING_READABLE);
	});

	it("never marks a device reading as simulated", async () => {
		feed.encoderLoad = MAINLINE_FRAME;
		expect((await readEncoderLoad()).simulated).toBe(false);
	});
});

describe("with no device reading at all", () => {
	it("falls back to the dev fixture, which says it is simulated", async () => {
		feed.encoderLoad = undefined;
		const reading = await readEncoderLoad();
		expect(reading.simulated).toBe(true);
		expect(reading.source).not.toBeNull();
	});
});
