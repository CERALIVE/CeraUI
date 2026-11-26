// @vitest-environment jsdom
/**
 * The store's side of `config_clear`, frame by frame: what it deletes, what it
 * leaves alone, and what it ignores. The device's own bytes drive
 * `config-clear.test.ts`; these frames are made up to isolate one rule each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	destroyDirtyRegistry,
	isPending,
	markPending,
	onRpcResolved,
} from "$lib/rpc/dirty-registry.svelte";
import {
	getConfig,
	ingestPulledConfig,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import { ingest } from "./device-loop";

beforeEach(() => {
	resetState();
	destroyDirtyRegistry();
});

afterEach(() => {
	resetState();
	destroyDirtyRegistry();
});

describe("the store deletes exactly the keys the device names", () => {
	it("an omitted key in a config frame still means unchanged", () => {
		ingest("config", { video_codec: "h264", resolution: "1080p" });

		ingest("config", { resolution: "720p" });

		expect(getConfig()).toEqual({ video_codec: "h264", resolution: "720p" });
	});

	it("a clear that crosses a newer pending choice deletes the stale value and keeps that choice's lock", () => {
		ingest("config", { video_codec: "h264" });
		markPending("video_codec", "h265");

		ingest("config_clear", { keys: ["video_codec"] });

		expect(Object.hasOwn(getConfig() ?? {}, "video_codec")).toBe(false);
		expect(isPending("video_codec")).toBe(true);
		ingest("config", { video_codec: "h265" });
		expect(getConfig()?.video_codec).toBe("h265");
		onRpcResolved("video_codec");
	});

	it("a malformed config_clear changes nothing", () => {
		ingest("config", { video_codec: "h264" });
		const before = getConfig();

		for (const payload of [
			undefined,
			null,
			{},
			{ keys: "video_codec" },
			{ keys: [1, null] },
		]) {
			ingest("config_clear", payload);
		}

		expect(getConfig()).toBe(before);
	});

	it("a message type this build does not know is ignored", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		ingest("config", { video_codec: "h264" });
		const before = getConfig();

		expect(() =>
			ingest("config_reset_v9", { keys: ["video_codec"] }),
		).not.toThrow();

		expect(getConfig()).toBe(before);
		warn.mockRestore();
	});
});

describe("a pulled config", () => {
	it("a key the snapshot omits keeps the local value while its field lock is pending", () => {
		ingest("config", { source: "cam-h265", max_br: 6000 });
		markPending("max_br", 8000);

		ingestPulledConfig({ source: "cam-h265" });

		expect(getConfig()?.max_br).toBe(6000);
		onRpcResolved("max_br");
	});
});
