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
import { streamingStartOutputSchemaExtended } from "@ceraui/rpc/schemas";
import { call, type Procedure } from "@orpc/server";
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
import { handleORPCMessage } from "../rpc/adapter.ts";
import { initSocketData } from "../rpc/context.ts";
import {
	initUiBuildIdentity,
	uiBuildMiddleware,
	uiBuildStartMiddleware,
} from "../rpc/middleware/ui-build.middleware.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
	streamingStartProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import { appRouter } from "../rpc/router.ts";
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

/** Every call the gate refuses, with an input its handler would act on. */
const GATED: ReadonlyArray<readonly [path: string, input: unknown]> = [
	["streaming.start", {}],
	["streaming.setConfig", { max_br: 5000 }],
	["streaming.setConfig", { video_codec: null }],
	["streaming.setSourceVisibility", { hide_test_pattern: true }],
	["streaming.setAudioMix", { id: "usb-a", mute: true }],
	["streaming.switchInput", { input_id: "/dev/video0" }],
	["streaming.switchAudio", { audio_input_id: "audio:usb-a" }],
	["streaming.reloadAudioDelay", { delay_ms: 100 }],
];
const UNGATED = [
	"getAudioCodecs",
	"getConfig",
	"getEngine",
	"getMockHardware",
	"getPipelines",
	"listDevices",
	"setBitrate",
	"setMockDeviceAttached",
	"setMockHardware",
	"stop",
	"streamHealth",
];

/** What the socket is sent for a call: the adapter's own reply, as its page gets it. */
async function replyTo(
	context: RPCContext,
	sent: string[],
	path: string,
	input: unknown,
): Promise<Record<string, unknown>> {
	await handleORPCMessage(context.ws, {
		id: path,
		path: path.split("."),
		input,
	});
	return sent
		.map((message) => JSON.parse(message) as Record<string, unknown>)
		.findLast((frame) => frame.id === path) as Record<string, unknown>;
}

describe("which calls are gated", () => {
	test("every streaming procedure is in exactly one of the two lists", () => {
		expect(
			[
				...new Set(GATED.map(([path]) => path.split(".")[1])),
				...UNGATED,
			].sort(),
		).toEqual(Object.keys(appRouter.streaming).sort());
	});

	for (const name of UNGATED) {
		test(`${name} carries no gate`, () => {
			const procedure = Reflect.get(appRouter.streaming, name) as Procedure<
				never,
				never,
				never,
				never,
				never
			>;

			for (const { middleware } of procedure["~orpc"].orderedMiddlewares)
				expect([uiBuildMiddleware, uiBuildStartMiddleware]).not.toContain(
					middleware as never,
				);
		});
	}
});

describe("a page from another build, or one that names none", () => {
	for (const announced of ["build-old", null]) {
		for (const [path, input] of GATED) {
			test(`(${announced ?? "none"}) ${path} ${JSON.stringify(input)} is refused before any change or engine call, and the page is told to reload`, async () => {
				const sent: string[] = [];
				const before = JSON.stringify(getConfig());

				const reply = await replyTo(
					uiSocket(announced, sent),
					sent,
					path,
					input,
				);

				// Start resolves: a page reads a thrown Start as a lost reply, and shows nothing.
				expect(reply).toEqual(
					path === "streaming.start"
						? {
								id: path,
								result: {
									success: false,
									is_streaming: false,
									error: "UI_OUT_OF_DATE",
								},
							}
						: {
								id: path,
								error: {
									message: "This page is out of date. Reload to continue.",
									code: "INTERNAL_ERROR",
								},
							},
				);
				expect(JSON.stringify(getConfig())).toBe(before);
				expect(getMockState().engineStart).toBeNull();
				// `msg` for a bundle from before the key existed, `key` for a localized one.
				expect(reloadNotices(sent)).toEqual([
					{
						msg: "This page is out of date. Reload to continue.",
						key: "notifications.uiOutOfDate",
					},
				]);
			});
		}

		test(`(${announced ?? "none"}) is refused the same way when its input is one this build no longer takes`, async () => {
			const sent: string[] = [];
			const context = uiSocket(announced, sent);

			const start = await replyTo(context, sent, "streaming.start", {
				max_br: "fast",
			});
			expect(
				streamingStartOutputSchemaExtended.parse(start.result),
			).toMatchObject({ success: false, error: "UI_OUT_OF_DATE" });
			expect(
				await replyTo(context, sent, "streaming.setConfig", { max_br: "fast" }),
			).toMatchObject({
				error: { message: "This page is out of date. Reload to continue." },
			});
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
