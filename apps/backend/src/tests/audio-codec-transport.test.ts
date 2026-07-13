/*
 * C5 (coherence-contract-pass) — transport × audio-codec coherence.
 *
 * Covers the legacy `acodec: "pcm"` → "aac" load coercion (coerceLegacyAcodec +
 * the runtimeConfigSchema preprocess), the untouched-opus legacy fixture, and the
 * streaming.start transport×codec gate (opus refused over an MPEG-TS transport;
 * aac / absent accepted) reached through the real procedure in mock mode.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AUDIO_CODEC_UNSUPPORTED_TRANSPORT } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	coerceLegacyAcodec,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { logger } from "../helpers/logger.ts";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

// ---------------------------------------------------------------------------
// coerceLegacyAcodec — the pure load-time value coercion
// ---------------------------------------------------------------------------

describe("coerceLegacyAcodec — retired 'pcm' → 'aac'", () => {
	test("maps a legacy 'pcm' to 'aac' with a warning", () => {
		const warn = mock(() => {});
		const original = logger.warn;
		logger.warn = warn as unknown as typeof logger.warn;
		try {
			expect(coerceLegacyAcodec("pcm")).toBe("aac");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			logger.warn = original;
		}
	});

	test("passes opus/aac and any other value through untouched", () => {
		expect(coerceLegacyAcodec("opus")).toBe("opus");
		expect(coerceLegacyAcodec("aac")).toBe("aac");
		expect(coerceLegacyAcodec("mp3")).toBe("mp3");
		expect(coerceLegacyAcodec(undefined)).toBeUndefined();
	});
});

describe("runtimeConfigSchema.acodec — legacy 'pcm' coercion (C5)", () => {
	test("a config with acodec:'pcm' loads as 'aac'", () => {
		const parsed = runtimeConfigSchema.parse({ acodec: "pcm" });
		expect(parsed.acodec).toBe("aac");
	});

	test("acodec:'opus' loads unchanged (coercion targets ONLY pcm)", () => {
		expect(runtimeConfigSchema.parse({ acodec: "opus" }).acodec).toBe("opus");
		expect(runtimeConfigSchema.parse({ acodec: "aac" }).acodec).toBe("aac");
	});

	test("an unknown codec is still rejected by the strict enum", () => {
		expect(runtimeConfigSchema.safeParse({ acodec: "mp3" }).success).toBe(
			false,
		);
	});

	test("the legacy fixture (acodec:'opus') still loads UNCHANGED", () => {
		const fixture = JSON.parse(
			fs.readFileSync(
				path.join(import.meta.dir, "fixtures", "legacy-config.json"),
				"utf8",
			),
		);
		const parsed = runtimeConfigSchema.parse(fixture);
		expect(parsed.acodec).toBe("opus");
	});
});

// ---------------------------------------------------------------------------
// streaming.start — transport × audio-codec gate (mock mode; gate fires before
// the mock start branch)
// ---------------------------------------------------------------------------

describe("streaming.start — transport × audio-codec gate (C5)", () => {
	const savedMockMode = process.env.MOCK_MODE;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});

	beforeEach(() => {
		const config = getConfig();
		config.pipeline = undefined;
		config.source = undefined;
		config.acodec = undefined;
		config.relay_protocol = undefined;
	});

	afterEach(() => {
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
		const config = getConfig();
		config.pipeline = undefined;
		config.source = undefined;
		config.acodec = undefined;
		config.relay_protocol = undefined;
	});

	afterAll(() => {
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	test("acodec:'opus' over the default (srtla) transport → structured error rejection", async () => {
		const res = await call(
			streamingStartProcedure,
			{ acodec: "opus" },
			{ context: makeContext() },
		);
		expect(res).toEqual({
			success: false,
			is_streaming: false,
			error: AUDIO_CODEC_UNSUPPORTED_TRANSPORT,
		});
	});

	test("a persisted acodec:'opus' with an undefined protocol is refused", async () => {
		getConfig().acodec = "opus";
		const res = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(res.success).toBe(false);
		expect(res.error).toBe(AUDIO_CODEC_UNSUPPORTED_TRANSPORT);
		expect(res).not.toHaveProperty("reason");
	});

	test("acodec:'opus' is refused over an explicit rist transport too", async () => {
		const res = await call(
			streamingStartProcedure,
			{ acodec: "opus", relay_protocol: "rist" },
			{ context: makeContext() },
		);
		expect(res.error).toBe(AUDIO_CODEC_UNSUPPORTED_TRANSPORT);
	});

	test("acodec:'aac' passes the codec gate", async () => {
		const res = await call(
			streamingStartProcedure,
			{ acodec: "aac" },
			{ context: makeContext() },
		);
		expect(res.success).toBe(true);
		expect(res).not.toHaveProperty("error");
	});

	test("no acodec passes the codec gate (engine default)", async () => {
		const res = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(res.success).toBe(true);
	});
});
