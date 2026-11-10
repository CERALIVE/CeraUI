import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import WebSocket from "ws";
import * as mockService from "../mocks/mock-service.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import * as modemStatus from "../modules/modems/modem-status.ts";
import * as dns from "../modules/network/dns.ts";
import { getRemoteWebSocket, initRemote } from "../modules/remote/remote.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import {
	PROTOCOL_VERSION,
	type Result,
	ResultSchema,
	StatusSchema,
} from "../modules/remote-control/protocol.ts";
import {
	handleSelfFencingConfirm,
	handleSelfFencingOp,
	resetSelfFencingState,
} from "../modules/remote-control/self-fencing.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import * as ssh from "../modules/system/ssh.ts";
import { sendInitialStatus } from "../modules/ui/status.ts";
import { broadcastMsg, broadcastMsgExcept } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { getConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import { StubRemoteSocket, statusClient } from "./helpers/status-client.ts";

mock.module("ws", () => ({ default: StubRemoteSocket }));

const secrets = {
	ssh_pass: "P2S_SSH_68a2",
	pairing_secret: "P2S_PAIRING_9471",
	srt_streamid: "P2S_MEDIA_ID_f176",
	relay_streamid_override: "P2S_MEDIA_OVERRIDE_b21a",
} as const;
const APN_USER = "P2S_APN_USER_c32b";
const APN_PASSWORD = "P2S_APN_PASSWORD_49ef";
const AUTH_KEY = "P2S_REMOTE_AUTH_KEEP_72ba";
const UNRELATED = "P2S_NESTED_PASSWORD_KEEP_0d32";
const CID = "00000000-0000-4000-8000-000000000002";
const modem = {
	ifname: "wwan0",
	name: "Privacy modem",
	network_type: { supported: ["lte"], active: "lte" },
	status: {
		connection: "connected",
		network_type: "lte",
		signal: 80,
		roaming: false,
	},
	config: {
		apn: "carrier.example",
		username: APN_USER,
		password: APN_PASSWORD,
		roaming: false,
		network: "auto",
		autoconfig: false,
		autoconfig_supported: true,
	},
};

const collections: ReadonlyArray<{ name: string; value: unknown }> = [
	{ name: "record", value: { z: modem, a: { status: { signal: 42 } } } },
	{ name: "array", value: [modem, { status: { signal: 42 } }] },
	{ name: "multiple modems", value: { z: modem, a: modem } },
	{ name: "empty record", value: {} },
	{ name: "empty array", value: [] },
	{ name: "undefined", value: undefined },
	{ name: "null", value: null },
	{ name: "undefined and null rows", value: [undefined, modem, null] },
	{
		name: "empty and undefined credentials",
		value: {
			z: { config: { username: "", password: undefined, apn: "" } },
			a: { config: null },
			b: { config: undefined },
		},
	},
];

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Serialize independently: omit keys only when their holder is a known DTO. */
function expectedBytes(
	frame: unknown,
	config: unknown,
	modems: unknown,
): string {
	const apnConfigs = new WeakSet<object>();
	if (object(modems)) {
		for (const row of Object.values(modems)) {
			if (object(row) && object(row.config)) apnConfigs.add(row.config);
		}
	}
	return JSON.stringify(frame, function (this: unknown, key, value) {
		if (this === config && Object.hasOwn(secrets, key)) return undefined;
		if (
			object(this) &&
			apnConfigs.has(this) &&
			(key === "username" || key === "password")
		) {
			return undefined;
		}
		return value;
	});
}

function expectNoSecrets(bytes: string): void {
	for (const secret of [...Object.values(secrets), APN_USER, APN_PASSWORD]) {
		expect(bytes).not.toContain(secret);
	}
}

let original: ReturnType<typeof getConfig>;
let originalConfigPath: string;
let scratch: string;
let localClient: AppWebSocket | undefined;
let intervals: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
let now = 0;
let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

beforeEach(async () => {
	original = structuredClone(getConfig());
	originalConfigPath = getConfigFilePath();
	scratch = await mkdtemp(join(tmpdir(), "remote-config-privacy-"));
	setConfigFilePath(join(scratch, "config.json"));
	Object.assign(getConfig(), secrets, { remote_key: AUTH_KEY });
	now += 60_000;
	spyOn(Date, "now").mockReturnValue(now);
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
	spyOn(dns, "dnsCacheResolve").mockResolvedValue({
		addrs: ["127.0.0.1"],
		fromCache: false,
	});
	spyOn(ssh, "getSshStatus").mockResolvedValue(undefined);
	spyOn(modemStatus, "buildModemsWireMessage").mockReturnValue({ lte: modem });
	intervals = spyOn(globalThis, "setInterval");
});

afterEach(async () => {
	for (const result of intervals.mock.results) {
		if (result.type === "return") clearInterval(result.value);
	}
	if (localClient) removeClient(localClient);
	localClient = undefined;
	resetSelfFencingState();
	clearTimeout(watchdogTimer);
	watchdogTimer = undefined;
	resetStatusRelay();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), original);
	setConfigFilePath(originalConfigPath);
	mock.restore();
	await rm(scratch, { recursive: true, force: true });
});

async function authenticateRemote(): Promise<StubRemoteSocket> {
	await initRemote();
	const socket = getRemoteWebSocket();
	if (!(socket instanceof StubRemoteSocket)) throw new Error("missing remote");
	socket.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
	return socket;
}

for (const provider of ["ceralive", "belabox", "custom"] as const) {
	test(`${provider} initial config and modem status omit secrets while local hydration is byte-identical`, async () => {
		getConfig().remote_provider = provider;
		getConfig().custom_provider = {
			name: "Private provider",
			host: "remote.example",
			path: "/ws/remote",
			secure: true,
		};
		const local = new WebSocket("ws://localhost:12345");
		if (!(local instanceof StubRemoteSocket)) throw new Error("missing local");
		sendInitialStatus(local);
		const before = [...local.sent];
		const config = getConfig();
		const sourceBytes = JSON.stringify(config);

		const remote = await authenticateRemote();

		expect(remote.sent).toEqual(
			before.map((bytes) => {
				const frame = JSON.parse(bytes);
				return expectedBytes(frame, frame.config, frame.status?.modems);
			}),
		);
		expectNoSecrets(remote.sent.join("\n"));
		expect(remote.sent.join("\n")).toContain(AUTH_KEY);
		expect(before.join("\n")).toContain(secrets.ssh_pass);
		expect(before.join("\n")).toContain(APN_PASSWORD);
		local.sent.length = 0;
		sendInitialStatus(local);
		expect(local.sent).toEqual(before);
		expect(JSON.stringify(config)).toBe(sourceBytes);
	});
}

for (const row of collections) {
	test(`legacy config and modem frame preserve exact nonsecret bytes: ${row.name}`, async () => {
		const remote = await authenticateRemote();
		const config = {
			first: 1,
			...secrets,
			remote_key: AUTH_KEY,
			last: undefined,
		};
		const status = {
			first: "status-first",
			modems: row.value,
			diagnostic: { password: UNRELATED },
		};
		const frame = { config, status, modems: row.value, last: undefined };
		const before = JSON.stringify(frame);
		remote.sent.length = 0;

		remote.send(before);

		expect(remote.sent).toEqual([expectedBytes(frame, config, row.value)]);
		expectNoSecrets(remote.sent.join("\n"));
		expect(remote.sent.join("\n")).toContain(AUTH_KEY);
		expect(remote.sent.join("\n")).toContain(UNRELATED);
		expect(JSON.stringify(frame)).toBe(before);
	});

	for (const type of ["modems", "status"] as const) {
		for (const except of [false, true]) {
			test(`v2 ${type} ${except ? "except" : "ordinary"} wrapper preserves local bytes: ${row.name}`, () => {
				const payload = type === "modems" ? row.value : { modems: row.value };
				const before = JSON.stringify(payload);
				const frames: unknown[] = [];
				const localFrames: string[] = [];
				localClient = statusClient((frame) => localFrames.push(frame));
				addClient(localClient);
				setControlChannel({
					isConnected: () => true,
					sendFrame: (frame) => frames.push(frame),
				});
				const uuid = spyOn(crypto, "randomUUID").mockReturnValue(CID);
				try {
					if (except)
						broadcastMsgExcept(
							statusClient(() => {}),
							type,
							payload,
						);
					else broadcastMsg(type, payload);
				} finally {
					uuid.mockRestore();
				}

				expect(frames).toHaveLength(1);
				expect(localFrames).toHaveLength(1);
				const seq = JSON.parse(localFrames[0] ?? "").seq;
				expect(localFrames[0]).toBe(JSON.stringify({ [type]: payload, seq }));
				expect(JSON.stringify(frames[0])).toBe(
					expectedBytes(
						{
							v: PROTOCOL_VERSION,
							kind: "status",
							type,
							cid: CID,
							seq: 1,
							...(payload === undefined ? {} : { payload }),
						},
						undefined,
						row.value,
					),
				);
				expectNoSecrets(JSON.stringify(frames[0]));
				if (
					payload === undefined ||
					(object(payload) && !Array.isArray(payload))
				) {
					expect(StatusSchema.safeParse(frames[0]).success).toBe(true);
				}
				expect(JSON.stringify(payload)).toBe(before);
			});
		}
	}
}

for (const config of [
	{ first: 1, ...secrets, remote_key: AUTH_KEY, last: undefined },
	{
		ssh_pass: "",
		pairing_secret: undefined,
		srt_streamid: "",
		relay_streamid_override: undefined,
		nested: { password: UNRELATED },
	},
	{},
	[],
	null,
	undefined,
]) {
	for (const except of [false, true]) {
		test(`v2 config ${except ? "except" : "ordinary"} preserves exact remaining bytes: ${JSON.stringify(config)}`, () => {
			const frames: unknown[] = [];
			const before = JSON.stringify(config);
			const localFrames: string[] = [];
			localClient = statusClient((frame) => localFrames.push(frame));
			addClient(localClient);
			setControlChannel({
				isConnected: () => true,
				sendFrame: (frame) => frames.push(frame),
			});
			const uuid = spyOn(crypto, "randomUUID").mockReturnValue(CID);
			try {
				if (except)
					broadcastMsgExcept(
						statusClient(() => {}),
						"config",
						config,
					);
				else broadcastMsg("config", config);
			} finally {
				uuid.mockRestore();
			}

			expect(frames).toHaveLength(1);
			expect(localFrames).toHaveLength(1);
			const seq = JSON.parse(localFrames[0] ?? "").seq;
			expect(localFrames[0]).toBe(JSON.stringify({ config, seq }));
			expect(JSON.stringify(frames[0])).toBe(
				expectedBytes(
					{
						v: PROTOCOL_VERSION,
						kind: "status",
						type: "config",
						cid: CID,
						seq: 1,
						...(config === undefined ? {} : { payload: config }),
					},
					config,
					undefined,
				),
			);
			expectNoSecrets(JSON.stringify(frames[0]));
			expect(JSON.stringify(config)).toBe(before);
		});
	}
}

test("actual remote streaming.getConfig omits media keys and preserves local RPC bytes and remote authentication", async () => {
	const context = buildControlContext();
	const local = await call(getConfigProcedure, undefined, { context });
	const before = JSON.stringify(local);
	const frames: Result[] = [];

	await routeCommand(
		{
			v: PROTOCOL_VERSION,
			kind: "command",
			type: "streaming.getConfig",
			role: "owner",
			cid: CID,
		},
		{
			sendResult: (frame) => {
				frames.push(frame);
				return true;
			},
		},
	);

	expect(frames).toHaveLength(1);
	expect(JSON.stringify(frames[0])).toBe(
		expectedBytes(
			{
				v: PROTOCOL_VERSION,
				kind: "result",
				type: "streaming.getConfig",
				cid: CID,
				role: "owner",
				payload: { ok: true, applied: local },
			},
			local,
			undefined,
		),
	);
	expectNoSecrets(JSON.stringify(frames));
	expect(JSON.stringify(frames)).toContain(AUTH_KEY);
	expect(ResultSchema.safeParse(frames[0]).success).toBe(true);
	expect(
		JSON.stringify(await call(getConfigProcedure, undefined, { context })),
	).toBe(before);
	expect(before).toContain(secrets.srt_streamid);
	expect(before).toContain(secrets.relay_streamid_override);
});

for (const type of [
	"network.reconfig",
	"modem.reconfig",
	"device.remoteKeyChange",
]) {
	for (const confirm of [false, true]) {
		test(`${type} ${confirm ? "commit" : "rollback"} results omit secrets but retain complete device snapshots`, async () => {
			const config = getConfig();
			const snapshot = structuredClone(config);
			const frames: Result[] = [];
			const terminal = Promise.withResolvers<void>();
			let watchdog = () => {};
			const frame = {
				v: PROTOCOL_VERSION,
				kind: "command",
				type,
				cid: CID,
				role: "owner",
				self_fencing: true,
				payload: { max_br: 6000 },
			} as const;

			await handleSelfFencingOp(frame, {
				sendResult: (result) => {
					frames.push(result);
					if (frames.length === 2) terminal.resolve();
					return true;
				},
				isSubsystemReady: async () => true,
				acquireMutationLease: async () => ({ ok: true }),
				admitDisruptiveAction: async () => ({ ok: true }),
				setTimer: (fn, ms) => {
					watchdog = fn;
					watchdogTimer = setTimeout(() => {}, ms);
					return watchdogTimer;
				},
			});
			if (confirm) await handleSelfFencingConfirm(CID);
			else watchdog();
			await terminal.promise;

			const applied = { ...snapshot, max_br: 6000 };
			expect(frames).toHaveLength(2);
			for (const [index, result] of frames.entries()) {
				const state = index === 0 || confirm ? applied : snapshot;
				expect(JSON.stringify(result)).toBe(
					expectedBytes(
						{
							v: PROTOCOL_VERSION,
							kind: "result",
							type,
							cid: CID,
							role: "owner",
							...(index === 0 ? { self_fencing: true } : {}),
							payload: {
								ok: true,
								applied: state,
								...(index === 0 ? {} : { reverted: !confirm }),
							},
						},
						state,
						undefined,
					),
				);
				expect(ResultSchema.safeParse(result).success).toBe(true);
			}
			expectNoSecrets(JSON.stringify(frames));
			expect(JSON.stringify(frames)).toContain(AUTH_KEY);
			expect(config).toStrictEqual(confirm ? applied : snapshot);
		});
	}
}

test("legacy encoder authentication fields remain byte-identical", async () => {
	const remote = await authenticateRemote();
	const frame =
		'{ "remote": { "auth/encoder": { "key": "P2S_REMOTE_AUTH_KEEP_72ba", "version": 16 } } }\n';
	remote.sent.length = 0;

	remote.send(frame);

	expect(remote.sent).toEqual([frame]);
});
