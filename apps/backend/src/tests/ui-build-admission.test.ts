/**
 * An open tab from before an upgrade keeps running the old code, so it cannot
 * apply `config_clear` and may show one choice while Start launches another.
 * The page announces the build it was served from on its socket URL; a UI
 * socket that announces none, or another build, has its Start and its Live
 * source, format, audio and mixer writes refused before any change or engine
 * call, and is told to reload. The cloud dashboard's device-control channel is
 * not a UI socket and is never gated, and nothing gates a read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { call } from "@orpc/server";
import {
	getMockState,
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { initSocketData } from "../rpc/context.ts";
import {
	initUiBuildIdentity,
	UI_OUT_OF_DATE_MESSAGE,
} from "../rpc/middleware/ui-build.middleware.ts";
import { setAudioMixProcedure } from "../rpc/procedures/audio-mix.procedure.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
	streamingStartProcedure,
	switchAudioProcedure,
	switchInputProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { RPCContext } from "../rpc/types.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [],
};
const BUILD = "build-new";
const savedMode = process.env.MOCK_MODE;
let previousMaxBr: number | undefined;

/** A UI socket as the upgrade records it, carrying what its page announced. */
function uiSocket(announced: string | null, sent: string[] = []): RPCContext {
	const context = makeRpcContext(sent);
	context.ws.data.uiBuild = announced;
	return context;
}

function reloadNotices(
	sent: readonly string[],
): Array<{ msg: string; key?: string }> {
	return sent
		.map((message) => JSON.parse(message) as { notification?: unknown })
		.flatMap((frame) => {
			const show = (
				frame.notification as {
					show?: Array<{ msg: string; key?: string }>;
				}
			)?.show;
			return show?.map(({ msg, key }) => ({ msg, key })) ?? [];
		});
}

beforeEach(async () => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
	await initUiBuildIdentity(async () => BUILD);
	previousMaxBr = getConfig().max_br;
	getConfig().max_br = 6000;
});

afterEach(async () => {
	await initUiBuildIdentity(async () => undefined);
	setStreamingState(false);
	updateStatus(false);
	resetMockState();
	stopMockService();
	clearCapabilitiesCache();
	getConfig().max_br = previousMaxBr;
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

describe("the socket upgrade records the build the page announced", () => {
	test("a UI socket carries its announced build, or null when it announced none", () => {
		expect(
			initSocketData(new URL(`ws://device/ws?ui_build=${BUILD}`)).uiBuild,
		).toBe(BUILD);
		expect(initSocketData(new URL("ws://device/ws")).uiBuild).toBeNull();
	});
});

describe("a page from this build", () => {
	test("saves a setting and starts", async () => {
		const context = uiSocket(BUILD);

		expect(
			await call(setConfigProcedure, { max_br: 5000 }, { context }),
		).toMatchObject({ success: true });
		expect(getConfig().max_br).toBe(5000);
		expect(await call(streamingStartProcedure, {}, { context })).toMatchObject({
			success: true,
		});
		expect(getMockState().engineStart).not.toBeNull();
	});
});

describe("a page from another build, or one that names none", () => {
	for (const announced of ["build-old", null]) {
		test(`(${announced ?? "none"}) is refused Start and every Live write before any change or engine call, and told to reload`, async () => {
			const sent: string[] = [];
			const context = uiSocket(announced, sent);
			const before = JSON.stringify(getConfig());

			for (const [procedure, input] of [
				[setConfigProcedure, { max_br: 5000 }],
				[setConfigProcedure, { video_codec: null }],
				[streamingStartProcedure, {}],
				[setAudioMixProcedure, { id: "usb-a", mute: true }],
				[switchInputProcedure, { input_id: "/dev/video0" }],
				[switchAudioProcedure, { asrc: "usb-a" }],
			] as const) {
				await expect(
					// biome-ignore lint/suspicious/noExplicitAny: one loop drives several procedure types.
					call(procedure as any, input, { context }),
				).rejects.toMatchObject({ message: UI_OUT_OF_DATE_MESSAGE });
			}

			expect(JSON.stringify(getConfig())).toBe(before);
			expect(getMockState().engineStart).toBeNull();
			// `msg` for a bundle from before the key existed, `key` for a localized one.
			expect(reloadNotices(sent)).toContainEqual({
				msg: UI_OUT_OF_DATE_MESSAGE,
				key: "notifications.uiOutOfDate",
			});
			expect(UI_OUT_OF_DATE_MESSAGE).toBe(
				"This page is out of date. Reload to continue.",
			);
		});
	}

	test("still reads, exactly what a page from this build reads", async () => {
		const read = (context: RPCContext) =>
			call(getConfigProcedure, undefined, { context });

		expect(await read(uiSocket("build-old"))).toEqual(
			await read(uiSocket(BUILD)),
		);
	});
});

describe("what is never gated", () => {
	test("the device-control channel, which is not a UI socket", async () => {
		const control = makeRpcContext();

		expect(
			await call(setConfigProcedure, { max_br: 5000 }, { context: control }),
		).toMatchObject({ success: true });
	});

	test("anything, on a backend that has no build identity of its own", async () => {
		await initUiBuildIdentity(async () => undefined);

		expect(
			await call(
				setConfigProcedure,
				{ max_br: 5000 },
				{ context: uiSocket("build-old") },
			),
		).toMatchObject({ success: true });
	});
});
