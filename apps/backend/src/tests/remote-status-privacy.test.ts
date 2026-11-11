import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { wifiInterfaceSchema } from "@ceraui/rpc/schemas";
import * as mockService from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import * as dns from "../modules/network/dns.ts";
import { getRemoteWebSocket, initRemote } from "../modules/remote/remote.ts";
import { StatusSchema } from "../modules/remote-control/protocol.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import * as ssh from "../modules/system/ssh.ts";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { broadcastMsg, broadcastMsgExcept } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import {
	OTHER_PASSWORD,
	HOTSPOT_PASSWORD as PASSWORD,
	remoteStatusCases,
} from "./helpers/remote-status-cases.ts";
import { StubRemoteSocket, statusClient } from "./helpers/status-client.ts";
import { fakeShadowSysfs } from "./helpers/wifi-radio-equivalence-shadow.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

mock.module("ws", () => ({ default: StubRemoteSocket }));

let registry: ReturnType<typeof isolateWifiRegistry>;
let previousRemoteKey: string | undefined;
let intervalSpy: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
let remoteClient: AppWebSocket | undefined;
let localClient: AppWebSocket | undefined;

beforeEach(() => {
	registry = isolateWifiRegistry();
	previousRemoteKey = getConfig().remote_key;
	getConfig().remote_key = "synthetic-remote-key";
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
	spyOn(dns, "dnsCacheResolve").mockResolvedValue({
		addrs: ["127.0.0.1"],
		fromCache: false,
	});
	spyOn(ssh, "getSshStatus").mockResolvedValue(undefined);
	spyOn(capabilities, "refreshWifiLinkTelemetry").mockResolvedValue(undefined);
	spyOn(capabilities, "getWifiCapabilitiesForInterface").mockReturnValue({
		phy: "phy0",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "supported",
		regulatory: { country: "US", is6GhzLegal: false, self_managed: false },
	});
	intervalSpy = spyOn(globalThis, "setInterval");
});

afterEach(() => {
	for (const result of intervalSpy.mock.results) {
		if (result.type === "return") clearInterval(result.value);
	}
	if (remoteClient) removeClient(remoteClient);
	if (localClient) removeClient(localClient);
	remoteClient = localClient = undefined;
	getConfig().remote_key = previousRemoteKey;
	restoreWifiRegistry(registry);
	resetStatusRelay();
	mock.restore();
});

function seedRadio(hybrid: boolean, active = true): WifiInterfaceWithHotspot {
	const iface: WifiInterfaceWithHotspot = {
		id: 0,
		ifname: "wlan0",
		hw: "Privacy test radio",
		conn: hybrid ? "upstream" : active ? "hotspot" : null,
		activeConn: hybrid ? "upstream" : active ? "hotspot" : null,
		activeMode: hybrid || !active ? "infrastructure" : "ap",
		available: new Map(),
		saved: { Upstream: "upstream" },
		savedAll: {},
		...(hybrid
			? {
					supportsApStaConcurrency: true,
					concurrentHotspot: { ifname: "clap-wlan0", activeConn: "hotspot" },
				}
			: {}),
		hotspot: {
			conn: "hotspot",
			name: "Privacy test AP",
			password: PASSWORD,
			channel: "auto",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
	addWifiInterface("aa:bb:cc:dd:ee:ff", iface);
	return iface;
}

function expectSafeStatus(
	bytes: string,
	original: ReturnType<typeof wifiBuildMsg>,
) {
	const expected = structuredClone(original);
	for (const entry of Object.values(expected)) {
		delete entry.incarnation;
	}
	expect(bytes).toContain(PASSWORD);
	const status: { wifi: ReturnType<typeof wifiBuildMsg> } =
		JSON.parse(bytes).status;
	expect(status.wifi).toStrictEqual(expected);
	for (const entry of Object.values(status.wifi)) {
		if (entry.hotspot)
			expect(entry.hotspot).toHaveProperty("password", PASSWORD);
		expect(wifiInterfaceSchema.safeParse(entry).success).toBe(true);
	}
}

async function authenticateRemote(): Promise<StubRemoteSocket> {
	await initRemote();
	const socket = getRemoteWebSocket();
	expect(socket).toBeInstanceOf(StubRemoteSocket);
	if (!(socket instanceof StubRemoteSocket)) throw new Error("missing remote");
	socket.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
	return socket;
}

for (const hybrid of [false, true]) {
	const mode = hybrid ? "concurrent" : "exclusive";

	test(`${mode} AP initial status after legacy authentication includes the password`, async () => {
		seedRadio(hybrid);
		const local = wifiBuildMsg();
		expect(local[0]?.hotspot?.password).toBe(PASSWORD);

		const remote = await authenticateRemote();

		expect(remote.sent.join("\n")).toContain(PASSWORD);
		const status = remote.sent.find((frame) => "status" in JSON.parse(frame));
		expect(status).toBeDefined();
		if (status === undefined) throw new Error("missing initial status");
		expect(JSON.parse(status).status.wifi[0].hotspot).toHaveProperty(
			"password",
			PASSWORD,
		);
		expectSafeStatus(status, local);
		expect(wifiBuildMsg()).toEqual(local);
	});

	test(`${mode} AP later broadcast protects a remote socket and preserves local bytes`, async () => {
		seedRadio(hybrid);
		const remote = await authenticateRemote();
		const local = wifiBuildMsg();
		const localFrames: string[] = [];
		// Legacy sockets are not registered by production today. Exercise the
		// shared sender if a status broadcast is delivered to one in the future.
		remoteClient = statusClient((frame) => remote.send(frame));
		localClient = statusClient((frame) => localFrames.push(frame));
		addClient(remoteClient);
		addClient(localClient);
		remote.sent.length = 0;

		broadcastWifiState();

		expect(remote.sent).toHaveLength(1);
		expectSafeStatus(remote.sent[0] ?? "", local);
		expect(localFrames).toHaveLength(1);
		const seq = JSON.parse(localFrames[0] ?? "").seq;
		expect(localFrames[0]).toBe(
			JSON.stringify({ status: { wifi: local }, seq }),
		);
		expect(localFrames[0]).toContain(PASSWORD);
		expect(wifiBuildMsg()).toEqual(local);
	});

	for (const except of [false, true]) {
		test(`${mode} AP v2 ${except ? "except" : "ordinary"} broadcast includes the password`, () => {
			seedRadio(hybrid);
			const local = wifiBuildMsg();
			const frames: unknown[] = [];
			setControlChannel({
				isConnected: () => true,
				sendFrame: (frame) => frames.push(frame),
			});

			if (except) {
				const client = statusClient(() => {});
				broadcastMsgExcept(client, "status", {
					wifi: local,
					is_streaming: true,
				});
			} else {
				broadcastMsg("status", { wifi: local, is_streaming: true });
			}

			expect(frames).toHaveLength(1);
			const bytes = JSON.stringify(frames[0]);
			expect(bytes).toContain(PASSWORD);
			expect(JSON.parse(bytes).payload.wifi[0].hotspot).toHaveProperty(
				"password",
				PASSWORD,
			);
			const frame = StatusSchema.parse(frames[0]);
			expectSafeStatus(JSON.stringify({ status: frame.payload }), local);
			expect(frame.payload?.is_streaming).toBe(true);
			expect(wifiBuildMsg()).toEqual(local);
		});
	}
}

test("an inactive hotspot retains its unchanged local and remote status", async () => {
	seedRadio(false, false);
	const local = wifiBuildMsg();
	expect(local[0]?.hotspot).toBeUndefined();

	const remote = await authenticateRemote();
	const initial = remote.sent.find((frame) => "status" in JSON.parse(frame));
	expect(JSON.parse(initial ?? "").status.wifi).toEqual(local);
	const frames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => frames.push(frame),
	});
	broadcastMsg("status", { wifi: local });

	expect(frames).toHaveLength(1);
	expect(StatusSchema.parse(frames[0]).payload).toEqual({ wifi: local });
	expect(remote.sent.join("\n")).not.toContain(PASSWORD);
	expect(JSON.stringify(frames)).not.toContain(PASSWORD);
	expect(wifiBuildMsg()).toEqual(local);
});

for (const row of remoteStatusCases) {
	test(`legacy frame preserves credentials and exact shape: ${row.name}`, async () => {
		const remote = await authenticateRemote();
		const local = {
			first: "envelope-first",
			status: {
				first: "status-first",
				wifi: row.local,
				modems: { lte: { config: { password: OTHER_PASSWORD } } },
				last: undefined,
			},
			id: "request-id",
		};
		const expected = {
			...local,
			status: {
				...local.status,
				wifi: row.remote,
			},
		};
		remote.sent.length = 0;

		remote.send(JSON.stringify(local));

		expect(remote.sent).toEqual([JSON.stringify(expected)]);
		expect(remote.sent.join("\n").includes(PASSWORD)).toBe(
			JSON.stringify(row.local)?.includes(PASSWORD) ?? false,
		);
		expect(remote.sent.join("\n")).toContain(OTHER_PASSWORD);
	});
}

for (const options of [false, true]) {
	test(`unrelated JSON bytes and send callback survive, options=${options}`, async () => {
		const remote = await authenticateRemote();
		const frame =
			'{ "config": { "password": "unrelated" }, "id": "keep spacing" }\n';
		let completed = 0;
		const callback = () => completed++;
		remote.sent.length = 0;

		if (options) remote.send(frame, { compress: false }, callback);
		else remote.send(frame, callback);

		expect(remote.sent).toEqual([frame]);
		expect(completed).toBe(1);
	});
}

test("observed radio tokens stay local through initial legacy status and both relay paths", async () => {
	const restore = await fakeShadowSysfs(() => [
		{
			ifname: "wlan0",
			ifindex: 10,
			phy: 0,
			permanent: "aa:bb:cc:dd:ee:ff",
			operational: "aa:bb:cc:dd:ee:ff",
			state: "disconnected",
		},
	]);
	try {
		const row = seedRadio(false);
		await wifiRadioIdentity.discover([{ ifname: "wlan0", row }]);
		const local = wifiBuildMsg();
		const token = local[0]?.incarnation;
		expect(token).toEqual(expect.any(String));
		if (!token) throw new Error("Missing observed token");
		const remote = await authenticateRemote();
		expect(remote.sent.join("\n")).not.toContain(token);
		expect(remote.sent.join("\n")).toContain(PASSWORD);
		const frames: unknown[] = [];
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => frames.push(frame),
		});
		broadcastMsg("status", { wifi: local });
		expect(frames).toHaveLength(1);
		expect(JSON.stringify(frames)).not.toContain(token);
		expect(JSON.stringify(frames)).toContain(PASSWORD);
		const iface = local[0];
		if (!iface) throw new Error("Missing observed radio");
		const { incarnation: _incarnation, ...legacy } = iface;
		expect(StatusSchema.parse(frames[0]).payload?.wifi).toStrictEqual({
			"0": legacy,
		});
		expect(wifiBuildMsg()).toStrictEqual(local);
	} finally {
		await restore();
	}
});
