/**
 * A cleared setting is sent as cleared (GAP-2, backend half).
 *
 * The device stores a cleared setting as absent, and the `config` broadcast is
 * JSON, which drops an absent key: the frame alone cannot tell a client the key
 * is gone. Every `config` broadcast goes through one helper that remembers the
 * keys clients were told about and, after a write that cleared any of them,
 * follows the unchanged `config` frame with `config_clear { keys }` on the same
 * sockets, so a client never re-adds a cleared key from the same write.
 */
import { describe, expect, test } from "bun:test";
import { GET_CONFIG_KEYS } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { getConfig } from "../modules/config.ts";
import {
	broadcastConfig,
	rememberConfigSent,
} from "../rpc/config-broadcast.ts";
import * as procedures from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import { useConfigClient } from "./helpers/config-client.ts";

const entry = (id: string, fields: Record<string, unknown> = {}) => ({
	id,
	tracks: [1],
	gain_db: 0,
	mute: false,
	delay_ms: 0,
	...fields,
});

const { tab, frames } = useConfigClient();

describe("config_clear", () => {
	test("clearing audio_inputs broadcasts config without the key, then config_clear naming it", async () => {
		Object.assign(getConfig(), {
			asrc: "Primary",
			audio_inputs: [entry("Primary"), entry("Second")],
		});
		// The clients were told about the saved mix by an earlier write's broadcast.
		broadcastConfig(getConfig());
		tab.sent = [];

		const result = await call(
			procedures.setConfigProcedure,
			{ audio_inputs: null },
			{ context: makeRpcContext() },
		);

		expect(result).toMatchObject({ success: true });
		const [config, clear, ...rest] = frames();
		expect(config?.config).toBeDefined();
		expect(Object.hasOwn(config?.config as object, "audio_inputs")).toBe(false);
		expect(clear?.config_clear).toEqual({ keys: ["audio_inputs"] });
		expect(rest).toEqual([]);
	});

	test("a key a client learned from its login snapshot is named when it is cleared", () => {
		Object.assign(getConfig(), {
			source: "cam-1",
			selected_video_input: "/dev/video0",
		});
		rememberConfigSent(getConfig());

		getConfig().selected_video_input = undefined;
		broadcastConfig(getConfig());

		expect(frames().map((frame) => Object.keys(frame)[0])).toEqual([
			"config",
			"config_clear",
		]);
		expect(frames()[1]?.config_clear).toEqual({
			keys: ["selected_video_input"],
		});
	});

	test("a write that clears nothing sends the config frame exactly as before, and nothing else", () => {
		Object.assign(getConfig(), { max_br: 6000, video_codec: "h264" });
		broadcastConfig(getConfig());

		getConfig().max_br = 8000;
		broadcastConfig(getConfig());

		expect(frames().map((frame) => Object.keys(frame)[0])).toEqual([
			"config",
			"config",
		]);
		expect(frames()[1]?.config).toEqual({ max_br: 8000, video_codec: "h264" });
	});

	test("a cleared key is named once: the next broadcast does not name it again", () => {
		Object.assign(getConfig(), { video_codec: "h264", max_br: 6000 });
		broadcastConfig(getConfig());
		getConfig().video_codec = undefined;
		broadcastConfig(getConfig());

		broadcastConfig(getConfig());

		expect(
			frames()
				.filter((frame) => "config_clear" in frame)
				.map((frame) => frame.config_clear),
		).toEqual([{ keys: ["video_codec"] }]);
	});

	test("a falsy or null value is a value the frame carries, not a clear", () => {
		Object.assign(getConfig(), {
			bitrate_overlay: true,
			srt_latency: 2000,
			srt_streamid: "live",
			custom_provider: { name: "x" },
		});
		broadcastConfig(getConfig());

		Object.assign(getConfig(), {
			bitrate_overlay: false,
			srt_latency: 0,
			srt_streamid: "",
			custom_provider: null,
		});
		broadcastConfig(getConfig());

		expect(frames().some((frame) => "config_clear" in frame)).toBe(false);
		expect(frames()[1]?.config).toEqual({
			bitrate_overlay: false,
			srt_latency: 0,
			srt_streamid: "",
			custom_provider: null,
		});
	});
});

describe("GET_CONFIG_KEYS", () => {
	test("equals the keys streaming.getConfig returns", async () => {
		const reply = await call(procedures.getConfigProcedure, undefined, {
			context: makeRpcContext(),
		});

		expect(Object.keys(reply).sort()).toEqual([...GET_CONFIG_KEYS].sort());
	});
});
