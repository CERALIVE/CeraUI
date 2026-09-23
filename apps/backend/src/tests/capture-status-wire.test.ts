import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusEventSchema } from "@ceralive/cerastream";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { RUNTIME_CONFIG_DEFAULTS } from "../helpers/config-schemas.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	getActiveEncodeStatus,
	setMockActiveEncodeProvider,
} from "../modules/streaming/active-encode-status.ts";
import { extractActiveEncode } from "../modules/streaming/cerastream-backend.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const captureStandbyStatusFrame = statusEventSchema.parse({
	type: "status",
	seq: 19,
	state: "streaming",
	streaming: true,
	active_encode: {
		codec: "h265",
		resolution: "1920x1080",
		framerate: 59.94,
		active_input: "standby",
		switch_targets: [
			{
				input_id: "camera-a",
				kind: "capture",
				source_width: 1920,
				source_height: 1080,
				source_framerate: 59.94,
			},
		],
		capture: {
			state: "standby",
			live_inputs: [],
			degraded_inputs: [{ input_id: "camera-a", cause: "no_signal" }],
			standby_since_ms: 1_725_000_000_000,
			suspension: {
				kind: "composition_primary_absent",
				since_ms: 1_725_000_000_000,
				resume_attempts: 2,
			},
			transition: { kind: "safe_harbor", since_ms: 1_725_000_000_100 },
			active_source: {
				input_id: "standby",
				width: 1920,
				height: 1080,
				framerate: 59.94,
				retimed: true,
				rescaled: false,
			},
			retime: { in: 120, out: 240, drop: 0, duplicate: 120 },
			failover_rate_policy: "retime",
		},
	},
});

const oldEngineStatusFrame = statusEventSchema.parse({
	type: "status",
	seq: 20,
	state: "streaming",
	streaming: true,
	active_encode: {
		codec: "h264",
		resolution: "1280x720",
		framerate: 30,
		active_input: "camera-a",
	},
});

function makeContext(): RPCContext {
	return {
		ws: {
			send: () => {},
			data: { isAuthenticated: true, lastActive: Date.now(), senderId: "test" },
		} as unknown as AppWebSocket,
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

const savedConfigPath = getConfigFilePath();
let configRoot: string | undefined;
let previousConfig: ReturnType<typeof getConfig>;

beforeAll(async () => {
	configRoot = await mkdtemp(join(tmpdir(), "ceraui-capture-status-wire-"));
	setConfigFilePath(join(configRoot, "config.json"));
});

beforeEach(() => {
	previousConfig = structuredClone(getConfig());
	getConfig().failover_rate_policy = undefined;
});

test("Given an unset runtime config, when defaults are applied, then capture failover starts with retime", () => {
	expect(RUNTIME_CONFIG_DEFAULTS.failover_rate_policy).toBe("retime");
});

afterEach(() => {
	Object.assign(getConfig(), previousConfig);
	getConfig().failover_rate_policy = previousConfig.failover_rate_policy;
	setMockActiveEncodeProvider(null);
});

afterAll(async () => {
	setConfigFilePath(savedConfigPath);
	if (configRoot !== undefined)
		await rm(configRoot, { recursive: true, force: true });
});

test("Given a producer-validated capture-standby frame, when it crosses the active-encode status path, then capture reaches the RPC schema unchanged", () => {
	if (captureStandbyStatusFrame.active_encode === undefined)
		throw new Error("capture standby fixture must include active_encode");

	const extracted = extractActiveEncode(captureStandbyStatusFrame);
	setMockActiveEncodeProvider(() => extracted);
	const activeEncode = getActiveEncodeStatus();
	const status = statusResponseSchema.parse({ active_encode: activeEncode });

	expect(status.active_encode?.capture).toEqual(
		captureStandbyStatusFrame.active_encode.capture,
	);
	expect(status.active_encode?.switch_targets).toEqual(
		captureStandbyStatusFrame.active_encode.switch_targets,
	);
});

test("Given a legacy engine frame without capture, when it crosses the status path, then its active-encode output is unchanged", () => {
	if (oldEngineStatusFrame.active_encode === undefined)
		throw new Error("legacy fixture must include active_encode");

	const extracted = extractActiveEncode(oldEngineStatusFrame);
	setMockActiveEncodeProvider(() => extracted);
	const status = statusResponseSchema.parse({
		active_encode: getActiveEncodeStatus(),
	});

	expect(status.active_encode).toEqual(oldEngineStatusFrame.active_encode);
});

test("Given a failover-rate policy save, when getConfig and setConfig run, then the value is persisted and echoed without live application", async () => {
	const setResult = await call(
		setConfigProcedure,
		{ failover_rate_policy: "adapt" },
		{ context: makeContext() },
	);
	const configResult = await call(getConfigProcedure, undefined, {
		context: makeContext(),
	});

	expect(setResult).toMatchObject({
		success: true,
		applied: { failover_rate_policy: "adapt" },
	});
	expect(getConfig().failover_rate_policy).toBe("adapt");
	expect(configResult.failover_rate_policy).toBe("adapt");
});
