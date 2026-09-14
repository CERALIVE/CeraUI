// biome-ignore-all lint/complexity/useLiteralKeys: bracket access injects the private client without changing the production API.
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	type ListSwitchTargetsResult,
	PROTOCOL_VERSION,
	rpcRequestSchema,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as config from "../modules/config.ts";
import {
	getPendingAudioFollowAsrc,
	getResolvedAsrc,
	resetAutoAudioState,
	setAutoAudioBroadcaster,
	setPendingAudioFollowAsrc,
	setResolvedAsrcFromStart,
} from "../modules/streaming/auto-audio.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { deviceRegistry } from "../modules/streaming/devices.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	setStreamingProcedureDepsForTest,
	switchInputProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

type PeerReply =
	| { readonly kind: "rpc-error"; readonly code: number }
	| { readonly kind: "roster"; readonly value: ListSwitchTargetsResult }
	| {
			readonly kind:
				| "disconnect"
				| "timeout"
				| "malformed-json"
				| "malformed-roster"
				| "malformed-error";
	  };

describe("session-switch admission through the real adapter and published UDS client", () => {
	let directory: string;
	let server: ReturnType<typeof Bun.listen>;
	let reply: PeerReply;
	let requests: string[];
	let originalConfigPath: string;
	let savedConfig: ReturnType<typeof config.getConfig>;
	let diskBefore: string;
	const originalClient = cerastreamBackend["client"];
	const legacy = spyOn(deviceRegistry, "switchInput");
	const persist = spyOn(config, "saveConfig");
	const audioSwitch = spyOn(cerastreamBackend, "switchAudio");
	const followSources = mock(() => ({
		hardware: "rk3588" as const,
		sources: [],
	}));
	const audioBroadcast = mock(() => undefined);
	afterAll(() => {
		legacy.mockRestore();
		persist.mockRestore();
		audioSwitch.mockRestore();
	});

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "ss-"));
		originalConfigPath = config.getConfigFilePath();
		savedConfig = structuredClone(config.getConfig());
		config.setConfigFilePath(join(directory, "config.json"));
		Object.assign(config.getConfig(), {
			source: "saved-camera",
			pipeline: "hdmi",
			selected_video_input: "saved-camera",
			asrc: AUDIO_SOURCE_AUTO,
		});
		config.saveConfig();
		diskBefore = await Bun.file(config.getConfigFilePath()).text();
		persist.mockClear();
		legacy
			.mockReset()
			.mockResolvedValue({ success: true, active_input: "candidate" });
		audioSwitch.mockClear();
		followSources.mockClear();
		setStreamingProcedureDepsForTest({ getSourcesMessage: followSources });
		resetAutoAudioState();
		setResolvedAsrcFromStart("HDMI", "hdmi");
		setPendingAudioFollowAsrc("previous-pending-mic");
		setAutoAudioBroadcaster(audioBroadcast);
		audioBroadcast.mockClear();
		updateStatus(true);
		requests = [];
		reply = { kind: "roster", value: { switch_targets: [] } };
		const socketPath = join(directory, "s");
		server = Bun.listen<{ pending: string }>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { pending: "" };
				},
				data(socket, bytes) {
					socket.data.pending += bytes.toString();
					const lines = socket.data.pending.split("\n");
					socket.data.pending = lines.pop() ?? "";
					for (const line of lines) {
						const request = rpcRequestSchema.parse(JSON.parse(line));
						requests.push(request.method);
						const respond = (body: Record<string, unknown>) =>
							socket.write(
								`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`,
							);
						if (request.method === "hello") {
							respond({
								result: {
									protocol: PROTOCOL_VERSION,
									schema_version: SCHEMA_VERSION,
									engine_version: "fixture",
								},
							});
							continue;
						}
						switch (reply.kind) {
							case "rpc-error":
								respond({
									error: { code: reply.code, message: "method not found" },
								});
								break;
							case "roster":
								respond({ result: reply.value });
								break;
							case "disconnect":
								socket.end();
								break;
							case "timeout":
								break;
							case "malformed-json":
								socket.write("{\n");
								break;
							case "malformed-roster":
								respond({
									result: {
										switch_targets: [
											{ input_id: "candidate", kind: "invented" },
										],
									},
								});
								break;
							case "malformed-error":
								respond({
									error: { code: "-32601", message: "method not found" },
								});
								break;
							default: {
								const exhaustive: never = reply;
								throw exhaustive;
							}
						}
					}
				},
			},
		});
		// Inject the connection, never listSwitchTargets or the adapter's classification.
		cerastreamBackend["client"] = await connect({
			socketPath,
			requestTimeoutMs: 100,
		});
	});

	afterEach(async () => {
		await cerastreamBackend["client"]?.close();
		cerastreamBackend["client"] = originalClient;
		server.stop(true);
		setStreamingProcedureDepsForTest(null);
		setAutoAudioBroadcaster(undefined);
		resetAutoAudioState();
		updateStatus(false);
		for (const key of Object.keys(config.getConfig()))
			Reflect.deleteProperty(config.getConfig(), key);
		Object.assign(config.getConfig(), savedConfig);
		config.setConfigFilePath(originalConfigPath);
		await rm(directory, { recursive: true, force: true });
	});

	async function expectRefusal(
		inputId = "candidate",
		expectedRequests = ["hello", "list-switch-targets"],
	) {
		// When: the authenticated procedure crosses the real adapter boundary.
		const before = structuredClone(config.getConfig());
		const result = await call(
			switchInputProcedure,
			{ input_id: inputId },
			{ context: makeRpcContext() },
		);
		// Then: neither discovery, switch dispatch, persistence nor audio follow ran.
		expect(result).toEqual({ success: false, error: "SWITCH_FAILED" });
		expect(requests).toEqual(expectedRequests);
		expect(legacy).not.toHaveBeenCalled();
		expect(followSources).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		expect(config.getConfig()).toEqual(before);
		expect(await Bun.file(config.getConfigFilePath()).text()).toBe(diskBefore);
		expect(audioSwitch).not.toHaveBeenCalled();
		expect(audioBroadcast).not.toHaveBeenCalled();
		expect(getResolvedAsrc()).toBe("HDMI");
		expect(getPendingAudioFollowAsrc()).toBe("previous-pending-mic");
	}

	test.each([-32700, -32600, -32602, -32603, -32000, -32001, -32099, 12345])(
		"refuses RPC error %s even when its message says method not found",
		async (code) => {
			// Given: a real JSON-RPC refusal, not an unsupported-method verdict.
			reply = { kind: "rpc-error", code };
			await expectRefusal();
		},
	);

	test.each([
		"disconnect",
		"timeout",
		"malformed-json",
		"malformed-roster",
		"malformed-error",
	] as const)("refuses %s without consulting discovery", async (kind) => {
		// Given: an unreadable roster is not a legacy engine.
		reply = { kind };
		await expectRefusal();
	});

	test("refuses an already closed client without consulting discovery", async () => {
		// Given: the published client has no usable transport.
		await cerastreamBackend["client"]?.close();
		await expectRefusal("candidate", ["hello"]);
	});

	test("refuses a missing session connection without consulting discovery", async () => {
		// Given: no adapter session exists to ask about support.
		await cerastreamBackend["client"]?.close();
		cerastreamBackend["client"] = undefined;
		await expectRefusal("candidate", ["hello"]);
	});

	test.each([
		{ switch_targets: [] },
		{ switch_targets: [{ input_id: "a", kind: "synthetic" }] },
	] satisfies ListSwitchTargetsResult[])(
		"refuses stale synthetic b neutrally against the fresh roster %j",
		async (value) => {
			// Given: b was displayed earlier, but the fresh snapshot no longer admits it.
			reply = { kind: "roster", value };
			await expectRefusal("b");
		},
	);

	test("permits the legacy registry path only for RPC method-not-found -32601", async () => {
		// Given: the same peer explicitly reports the query as unsupported.
		reply = { kind: "rpc-error", code: -32601 };
		// When: the procedure asks the real adapter to admit a switch.
		const result = await call(
			switchInputProcedure,
			{ input_id: "candidate" },
			{ context: makeRpcContext() },
		);
		// Then: the registry's answer is consumed once, with no session switch RPC.
		expect(result).toEqual({ success: true, active_input: "candidate" });
		expect(legacy).toHaveBeenCalledTimes(1);
		expect(legacy).toHaveBeenCalledWith("candidate");
		expect(followSources).toHaveBeenCalledTimes(1);
		expect(requests).toEqual(["hello", "list-switch-targets"]);
	});
});
