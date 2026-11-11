import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as mocks from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import * as dns from "../modules/network/dns.ts";
import { getRemoteWebSocket, initRemote } from "../modules/remote/remote.ts";
import { projectRemoteWifiFrame } from "../modules/remote/remote-status.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { broadcastMsg } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { StubRemoteSocket, statusClient } from "./helpers/status-client.ts";

mock.module("ws", () => ({ default: StubRemoteSocket }));

let previousKey: string | undefined;
let intervals: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
const localFrames: string[] = [];
const local = statusClient((raw) => localFrames.push(raw));

beforeEach(() => {
	previousKey = getConfig().remote_key;
	getConfig().remote_key = "synthetic-remote-key";
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	spyOn(dns, "dnsCacheResolve").mockResolvedValue({
		addrs: ["127.0.0.1"],
		fromCache: false,
	});
	intervals = spyOn(globalThis, "setInterval");
	localFrames.length = 0;
	addClient(local);
});

afterEach(() => {
	for (const result of intervals.mock.results) {
		if (result.type === "return") clearInterval(result.value);
	}
	removeClient(local);
	getConfig().remote_key = previousKey;
	resetStatusRelay();
	mock.restore();
});

const cases = [
	{ adapter_mode: { device: 0, mode: "hotspot", pending: true } },
	{ adapter_mode: { device: 0, mode: "hotspot", success: true } },
	{ adapter_mode: { device: 0, error: "not-confirmed" } },
	{ hotspot: { config: { device: 0, success: true } } },
	{ hotspot: { config: { device: 0, error: "saving" } } },
] as const;

for (const legacy of cases) {
	test(`legacy remote strips only frame incarnation: ${JSON.stringify(legacy)}`, async () => {
		const bound =
			"adapter_mode" in legacy
				? {
						adapter_mode: { ...legacy.adapter_mode, incarnation: "dispatch-A" },
					}
				: {
						hotspot: {
							config: { ...legacy.hotspot.config, incarnation: "dispatch-A" },
						},
					};
		const original = structuredClone(bound);
		expect(projectRemoteWifiFrame(bound)).toStrictEqual(legacy);
		expect(bound).toStrictEqual(original);

		const mutatingProjection = (input: typeof bound) => {
			const projected = projectRemoteWifiFrame(input);
			const frame =
				"adapter_mode" in input ? input.adapter_mode : input.hotspot.config;
			Reflect.deleteProperty(frame, "incarnation");
			return projected;
		};
		const control = structuredClone(original);
		expect(mutatingProjection(control)).toStrictEqual(legacy);
		expect(() => expect(control).toStrictEqual(original)).toThrow();
		await initRemote();
		const remote = getRemoteWebSocket();
		if (!(remote instanceof StubRemoteSocket))
			throw new Error("missing remote");
		const callback = mock(() => undefined);
		remote.send(
			JSON.stringify({ wifi: bound, id: "operator" }),
			{ compress: false },
			callback,
		);
		expect(remote.sent.at(-1)).toBe(
			JSON.stringify({ wifi: legacy, id: "operator" }),
		);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(bound).toStrictEqual(original);
		const cloudFrames: unknown[] = [];
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => cloudFrames.push(frame),
		});
		broadcastMsg("wifi", bound);
		expect(JSON.parse(localFrames.at(-1) ?? "{}").wifi).toStrictEqual(bound);
		expect(cloudFrames).toEqual([]);
	});
}

test("tokenless Wi-Fi and RPC bytes preserve their original serialization", async () => {
	await initRemote();
	const remote = getRemoteWebSocket();
	if (!(remote instanceof StubRemoteSocket)) throw new Error("missing remote");
	for (const raw of [
		' { "wifi": { "adapter_mode": { "device": 0, "success": true } } } ',
		' { "wifi": { "hotspot": { "config": { "device": 0, "error": "saving" } } } } ',
		' { "wifi": { "hotspot": { "start": { "device": 0, "success": true } } } } ',
		' { "id": "request", "result": { "success": true } } ',
	]) {
		remote.send(raw);
		expect(remote.sent.at(-1)).toBe(raw);
	}
});
