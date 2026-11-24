import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import {
	getConfigFilePath,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	isBondOptedOut,
	resetSessionBondOptOutForTest,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import {
	getNetworkInterfaces,
	setBondDisableGuardContext,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	clearBondNetworkFixture,
	makeRpcContext,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const [fixture] = constructedTwins;
if (fixture === undefined) throw new Error("Missing USB modem fixture");
const dell = { ...fixture, serial: "" };
const huawei = { ...dell, idVendor: "1e0e", idProduct: "9001" };
const modemIp = "198.51.100.2";
const modeKeys = [
	"NODE_ENV",
	"MOCK_MODE",
	"MOCK_SCENARIO",
	"HWSIM_REPO",
	"CERALIVE_DEVICE_TYPE",
] as const;
let savedModes: ReadonlyArray<readonly [string, string | undefined]>;
let previousPath: string;
let scratch: string;

beforeEach(async () => {
	savedModes = modeKeys.map((key) => [key, process.env[key]]);
	for (const key of modeKeys) delete process.env[key];
	process.env.NODE_ENV = "production";
	setBondDisableGuardContext(
		{ isStillReal: () => true, refresh: () => undefined },
		true,
	);
	previousPath = getConfigFilePath();
	scratch = await mkdtemp(join(tmpdir(), "bond-port-mode-switch-"));
	const path = join(scratch, "config.json");
	await writeFile(path, "{}");
	setConfigFilePath(path);
});

afterEach(async () => {
	for (const [key, value] of savedModes) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	clearBondNetworkFixture();
	setBondDisableGuardContext(undefined, false);
	resetSessionBondOptOutForTest();
	resetUsbNetMarkers();
	setConfigFilePath(previousPath);
	await rm(scratch, { recursive: true, force: true });
});

async function boot(device: typeof dell, mode: "real" | "emulated") {
	if (mode === "real") delete process.env.CERALIVE_DEVICE_TYPE;
	else process.env.CERALIVE_DEVICE_TYPE = mode;
	clearBondNetworkFixture();
	resetSessionBondOptOutForTest();
	resetUsbNetMarkers();
	await loadConfig();
	await refreshUsbNetMarkers([device.ifname], constructedTwinDeps([device]));
	for (const [name, ip] of [
		["eth0", "198.51.100.1"],
		[device.ifname, modemIp],
	] as const) {
		getNetworkInterfaces()[name] = {
			ip,
			netmask: "255.255.255.0",
			enabled: true,
			error: 0,
			tp: 0,
			txb: 0,
			rxb: 0,
			...(name === device.ifname && { usb: true, identitySettled: true }),
		};
	}
}

async function toggle(enabled: boolean) {
	expect(
		await call(
			configureNetworkInterfaceProcedure,
			{ name: dell.ifname, ip: modemIp, enabled },
			{ context: makeRpcContext() },
		),
	).toMatchObject({ success: true, applied: { enabled } });
}

const senders = () => genSrtlaBondEntries().map(({ iface }) => iface);

test.each([false, true])(
	"M1: another vendor's emulated OFF survives a real restart (prior ON: %j)",
	async (enableFirst) => {
		await boot(dell, "real");
		await toggle(false);
		await boot(huawei, "emulated");
		if (enableFirst) await toggle(true);
		await toggle(false);
		await boot(huawei, "emulated");
		expect(senders()).toEqual(["eth0"]);
		await boot(huawei, "real");
		expect(senders()).toEqual(["eth0"]);
		await boot(dell, "real");
		expect(senders()).toEqual(["eth0"]);
	},
);

test("M1 direct writer: a legacy port OFF still applies after an effective reload", async () => {
	await boot(dell, "real");
	setPersistentBondOptOut(dell.ifname, true);
	await boot(huawei, "emulated");
	setPersistentBondOptOut(huawei.ifname, true, "legacy");
	await boot(huawei, "real");
	expect(isBondOptedOut(huawei.ifname)).toBe(true);
});

test("a real OFF after an emulated OFF preserves the earlier legacy exclusion", async () => {
	await boot(huawei, "emulated");
	await toggle(false);
	await boot(dell, "real");
	await toggle(false);
	await boot(huawei, "real");
	expect(senders()).toEqual(["eth0"]);
});

test("a same-brand emulated re-OFF survives a real restart", async () => {
	await boot(dell, "real");
	await toggle(false);
	await boot(dell, "emulated");
	await toggle(false);
	await boot(dell, "real");
	expect(senders()).toEqual(["eth0"]);
});

test.each(["real", "emulated"] as const)(
	"an ON in %s mode supersedes the same modem's saved OFF after a restart",
	async (mode) => {
		await boot(dell, "real");
		await toggle(false);
		await boot(dell, "emulated");
		await toggle(false);
		await boot(dell, mode);
		await toggle(true);
		await boot(dell, "real");
		expect(senders()).toEqual(["eth0", dell.ifname]);
	},
);
