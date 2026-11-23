import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import {
	type DeviceDetectionDeps,
	isRealDevice,
} from "../modules/system/device-detection.ts";
import { handleORPCMessage } from "../rpc/adapter.ts";
import { bootDevice } from "./helpers/bond-guard-install.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const marker = "rockchip,rk3588";
const empty = async () => "";
function fixture(
	values: Partial<DeviceDetectionDeps> = {},
): DeviceDetectionDeps {
	return {
		getDeviceTypeOverride: () => undefined,
		isDevelopment: () => false,
		readDeviceTreeCompatible: empty,
		readDeviceTreeModel: empty,
		readCeraliveRelease: empty,
		readDmiProductName: empty,
		readDmiBoardName: empty,
		...values,
	};
}

async function settlement(promise: Promise<boolean>) {
	let value: boolean | undefined;
	void promise.then((answer) => {
		value = answer;
	});
	for (let ticks = 1; ticks <= 20; ++ticks) {
		await Promise.resolve();
		if (value !== undefined) return { ticks, value };
	}
	throw new Error(
		"Classifier did not settle within the fixture's microtask budget",
	);
}

test("startup gate matches ordinary main classification ticks across every branch", async () => {
	for (const [label, deps, ticks, value] of [
		[
			"compatible",
			fixture({ readDeviceTreeCompatible: async () => marker }),
			3,
			true,
		],
		["model", fixture({ readDeviceTreeModel: async () => marker }), 5, true],
		["clean nonmatch", fixture(), 7, false],
		[
			"synchronous read failure",
			fixture({
				readDeviceTreeCompatible: () => {
					throw new Error("EIO");
				},
			}),
			6,
			false,
		],
		[
			"I/O failure",
			fixture({
				readDeviceTreeCompatible: async () => {
					throw new Error("EIO");
				},
			}),
			7,
			false,
		],
		[
			"DMI match",
			fixture({
				readCeraliveRelease: async () => "ID=ceralive",
				readDmiBoardName: async () => "N100",
			}),
			11,
			true,
		],
		[
			"DMI nonmatch",
			fixture({ readCeraliveRelease: async () => "ID=ceralive" }),
			11,
			false,
		],
		["forced real", fixture({ getDeviceTypeOverride: () => "real" }), 1, true],
		[
			"forced emulated",
			fixture({ getDeviceTypeOverride: () => "emulated" }),
			1,
			false,
		],
		["dev/mock", fixture({ isDevelopment: () => true }), 1, false],
	] as const) {
		const ordinary = await settlement(isRealDevice(deps));
		const startup = await settlement(bootDevice(deps).ready);
		expect(ordinary, label).toEqual({ ticks, value });
		expect(startup, label).toEqual(ordinary);
	}
});

const selectors = [
	"NODE_ENV",
	"MOCK_MODE",
	"MOCK_SCENARIO",
	"HWSIM_REPO",
] as const;

for (const mode of ["production", "scenario", "hwsim", "test"] as const) {
	test(`startup sweep vs authenticated adapter reply: ${mode}`, async () => {
		const saved = selectors.map((key) => [key, process.env[key]] as const);
		const order: string[] = [];
		const probe = Promise.withResolvers<string>();
		try {
			for (const key of selectors) delete process.env[key];
			process.env.NODE_ENV = mode === "test" ? "test" : "production";
			if (mode === "scenario") process.env.MOCK_SCENARIO = "multi-modem-wifi";
			if (mode === "hwsim") process.env.HWSIM_REPO = "";

			const device = bootDevice(
				fixture({ readDeviceTreeCompatible: () => probe.promise }),
			);
			// Same continuation as main, with a receipt instead of OS recovery.
			const startup = (async () => {
				if (await device.ready) order.push("sweep");
			})();
			const { ws } = makeRpcContext();
			ws.send = (frame) => {
				if (typeof frame !== "string") throw new Error("Expected text reply");
				const answer: unknown = JSON.parse(frame);
				if (
					typeof answer === "object" &&
					answer !== null &&
					"id" in answer &&
					answer.id === "get"
				) {
					if (!("result" in answer))
						throw new Error("Expected authenticated RPC success");
					order.push("rpc");
				}
				return 0;
			};
			const reply = handleORPCMessage(ws, {
				id: "get",
				path: ["network", "getInterfaces"],
			});
			for (let tick = 0; tick < 11; ++tick) await Promise.resolve();
			probe.resolve(marker);
			await Promise.all([startup, reply]);
			if (process.env.BOND_STARTUP_TRACE)
				appendFileSync(
					process.env.BOND_STARTUP_TRACE,
					`${JSON.stringify({ mode, order })}\n`,
				);
			expect(order).toEqual(["sweep", "rpc"]);
		} finally {
			probe.resolve(marker);
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
}
