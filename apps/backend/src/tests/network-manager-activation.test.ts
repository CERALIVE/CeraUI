import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { MethodCall } from "@ceralive/modem-control/transport";
import * as transport from "@ceralive/modem-control/transport";
import { nmDisconnect } from "../modules/network/network-manager.ts";
import { nmActivationBus } from "../modules/network/network-manager-profile-instance.ts";
import {
	ACTIVE_PATH,
	mockActivationBus,
	RUN_ID,
} from "./helpers/wifi-active-observation.ts";

afterEach(() => mock.restore());

test("the NetworkManager activation socket uses the configured bus without reconnecting", () => {
	const original = process.env.DBUS_SYSTEM_BUS_ADDRESS;
	const create = spyOn(transport, "createDbusTransport");
	try {
		delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
		nmActivationBus.open();
		process.env.DBUS_SYSTEM_BUS_ADDRESS = "  unix:path=/fixture/system_bus  ";
		nmActivationBus.open();
		expect(create.mock.calls).toEqual([
			[
				{
					busAddress: "unix:path=/var/run/dbus/system_bus_socket",
					reconnect: { enabled: false },
				},
			],
			[
				{
					busAddress: "unix:path=/fixture/system_bus",
					reconnect: { enabled: false },
				},
			],
		]);
	} finally {
		if (original === undefined) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
		else process.env.DBUS_SYSTEM_BUS_ADDRESS = original;
	}
});

test("an acknowledged Down is not complete before that active connection is terminal", async () => {
	const read = Promise.withResolvers<"read">();
	const finish = mockActivationBus(
		() => RUN_ID.split("/")[0] ?? "",
		() => undefined,
		undefined,
		false,
		undefined,
		(property) => {
			if (property === "State") read.resolve("read");
		},
	);
	const disconnect: (
		uuid: string,
		path: string,
		runId: string,
		ifname: string,
	) => Promise<boolean> = nmDisconnect;
	const result = disconnect("policy-ap", ACTIVE_PATH, RUN_ID, "wlan0");
	try {
		expect(await Promise.race([read.promise, result])).toBe("read");
		const pending = Symbol("pending");
		expect(await Promise.race([result, Bun.sleep(0).then(() => pending)])).toBe(
			pending,
		);
	} finally {
		finish(ACTIVE_PATH);
	}
	expect(await result).toBe(true);
});

test("Down observes DEACTIVATED on the state read even while the path is still listed", async () => {
	let state = 2;
	mockActivationBus(
		() => RUN_ID.split("/")[0] ?? "",
		() => undefined,
		() => ({ uuid: "policy-ap", ifname: "wlan0", path: ACTIVE_PATH, state }),
		false,
		undefined,
		(property) => {
			if (property === "ActiveConnections") state = 4;
		},
	);
	expect(await nmDisconnect("policy-ap", ACTIVE_PATH, RUN_ID, "wlan0")).toBe(
		true,
	);
});

test("Down addresses the recorded unique daemon and activation path on its bus", async () => {
	const calls: MethodCall[] = [];
	mockActivationBus(
		() => "00000000000000000000000000000001",
		(call) => {
			calls.push(call);
		},
	);
	expect(await nmDisconnect("policy-ap", ACTIVE_PATH, RUN_ID, "wlan0")).toBe(
		true,
	);
	expect(calls.map(({ timeoutMs: _timeout, ...call }) => call)).toEqual([
		{
			destination: ":1.1",
			path: "/org/freedesktop/NetworkManager",
			interface: "org.freedesktop.NetworkManager",
			member: "DeactivateConnection",
			signature: "o",
			args: [ACTIVE_PATH],
		},
	]);
});

test.each(["different-uuid", "different-device"] as const)(
	"Down refuses a receipt whose active object has a %s",
	async (mismatch) => {
		const calls: MethodCall[] = [];
		mockActivationBus(
			() => RUN_ID.split("/")[0] ?? "",
			(call) => {
				calls.push(call);
			},
			() => ({
				uuid: mismatch === "different-uuid" ? "foreign" : "policy-ap",
				ifname: mismatch === "different-device" ? "wlan1" : "wlan0",
				path: ACTIVE_PATH,
			}),
		);
		const disconnect: (
			uuid: string,
			path: string,
			runId: string,
			ifname: string,
		) => Promise<boolean> = nmDisconnect;
		expect(await disconnect("policy-ap", ACTIVE_PATH, RUN_ID, "wlan0")).toBe(
			false,
		);
		expect(calls).toEqual([]);
	},
);

test("Down cannot reuse the path and daemon name on a replacement bus", async () => {
	const calls: MethodCall[] = [];
	mockActivationBus(
		() => "00000000000000000000000000000002",
		(call) => {
			calls.push(call);
		},
	);
	expect(await nmDisconnect("policy-ap", ACTIVE_PATH, RUN_ID, "wlan0")).toBe(
		false,
	);
	expect(calls).toEqual([]);
});
