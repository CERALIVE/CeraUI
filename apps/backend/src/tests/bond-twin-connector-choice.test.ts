import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { getConfig, loadConfig, setConfigFilePath } from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
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
import rollbackCleanSave from "./fixtures/real-device/bond-connector-v2026.11.4-clean-save.json";
import {
	clearBondNetworkFixture,
	makeRpcContext,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const group1 = "CONSTRUCTED-SHARED-G1";
const group2 = "CONSTRUCTED-SHARED-G2";
const [a, b] = constructedTwins;
if (a === undefined || b === undefined)
	throw new Error("Expected two USB connectors");
const [first, second] = [a.ifname, b.ifname];
type Device = (typeof constructedTwins)[number];
let directory: string;
let file: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bond-connector-"));
	file = join(directory, "config.json");
	setConfigFilePath(file);
	await writeFile(
		file,
		JSON.stringify({
			bond_opt_out: Object.fromEntries(
				[group1, group2].map((group) => [
					mintLinkId(`usb-serial:413c:${group}`),
					true,
				]),
			),
			usb_serial_shared: [group1, group2].map((group) =>
				new Bun.CryptoHasher("sha256").update(`413c:${group}`).digest("hex"),
			),
		}),
	);
	await loadConfig();
});

afterEach(async () => {
	setBondDisableGuardContext(undefined, false);
	clearBondNetworkFixture();
	resetUsbNetMarkers();
	resetSessionBondOptOutForTest();
	setConfigFilePath("config.json");
	await rm(directory, { recursive: true, force: true });
});

function addUplinks() {
	for (const [name, ip] of [
		["eth0", "192.0.2.1"],
		[second, "198.51.100.2"],
	] as const) {
		getNetworkInterfaces()[name] = {
			ip,
			netmask: "255.255.255.0",
			enabled: true,
			error: 0,
			tp: 0,
			txb: 0,
			rxb: 0,
			...(name === second ? { usb: true, identitySettled: true } : {}),
		};
	}
}

async function realDevice<T>(action: () => Promise<T>): Promise<T> {
	const keys = [
		"NODE_ENV",
		"MOCK_MODE",
		"MOCK_SCENARIO",
		"HWSIM_REPO",
	] as const;
	const saved = keys.map((key) => [key, process.env[key]] as const);
	try {
		process.env.NODE_ENV = "production";
		for (const key of keys.slice(1)) delete process.env[key];
		setBondDisableGuardContext(
			{ isStillReal: () => true, refresh: () => {} },
			true,
		);
		return await action();
	} finally {
		setBondDisableGuardContext(undefined, false);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const turnEthernetOff = () =>
	call(
		configureNetworkInterfaceProcedure,
		{ name: "eth0", ip: "192.0.2.1", enabled: false },
		{ context: makeRpcContext() },
	);

async function scan(...devices: Device[]) {
	await refreshUsbNetMarkers(
		devices.map(({ ifname }) => ifname),
		{
			...constructedTwinDeps(devices),
			sharedSerials: {
				load: () => getConfig().usb_serial_shared ?? [],
				save: (hashes) => {
					getConfig().usb_serial_shared = hashes;
				},
			},
		},
	);
}

function included(...names: string[]) {
	return names.map((name) => !isBondOptedOut(name));
}

async function reload() {
	resetSessionBondOptOutForTest();
	resetUsbNetMarkers();
	await loadConfig();
}

test.each([
	["R5b-A unreadable OFF then ON", "", "81d7", false],
	["R5b-A visible OFF then unreadable ON", "", "81d7", true],
	["R5-H1 another USB mode", "", "81d8", true],
	["placeholder 0000 ON", "0000", "81d7", false],
] as const)(
	"%s persists and outranks the default after recognition",
	async (_name, serial, idProduct, visibleOff) => {
		const twin = { ...b, serial: group1 };
		if (visibleOff) {
			await scan(twin);
			setPersistentBondOptOut(second, true);
		}
		const unconfirmed = { ...b, serial, idProduct };
		await scan(unconfirmed);
		if (!visibleOff) setPersistentBondOptOut(second, true);
		setPersistentBondOptOut(second, false);
		await reload();
		await scan(unconfirmed);
		expect(included(second)).toEqual([true]);
		const bytes = await Bun.file(file).text();
		await scan({ ...a, serial: group1 }, twin);
		expect(included(first, second)).toEqual([false, true]);
		expect(await Bun.file(file).text()).toBe(bytes);
	},
);

test("F2-H1 keeps an unseen sibling excluded after enabling the first twin", async () => {
	await scan({ ...a, serial: group1 });
	setPersistentBondOptOut(first, false);
	await reload();
	await scan({ ...a, serial: group1 }, { ...b, serial: group1 });
	expect(included(first, second)).toEqual([true, false]);
});

test("R5b-S a group-less ON follows the same-brand connector into another pair", async () => {
	await scan({ ...a, serial: group1 }, { ...b, serial: group1 });
	setPersistentBondOptOut(second, true);
	const replacement = { ...b, serial: "", idProduct: "81d8" };
	await scan(replacement);
	setPersistentBondOptOut(second, false);
	await reload();
	await scan({ ...a, serial: group2 }, { ...b, serial: group2 });
	expect(included(first, second)).toEqual([false, true]);
});

test("a sole selected twin survives reassigned udev paths at the same connectors", async () => {
	const twinA = { ...a, serial: group1 };
	const twinB = { ...b, serial: group1 };
	await scan(twinA, twinB);
	setPersistentBondOptOut(second, false);
	await reload();
	await scan(twinB);
	addUplinks();
	expect(await realDevice(turnEthernetOff)).toMatchObject({ success: true });
	await scan({ ...twinB, udevadm: a.udevadm });
	expect(genSrtlaBondEntries().map(({ iface }) => iface)).toEqual([second]);
	await scan(
		{ ...twinA, udevadm: b.udevadm },
		{ ...twinB, udevadm: a.udevadm },
	);
	expect(included(first, second)).toEqual([false, true]);
});

test("a default-IN unreadable twin cannot justify disabling the only known uplink", async () => {
	await scan({ ...b, serial: "" });
	addUplinks();
	expect(await realDevice(turnEthernetOff)).toEqual({
		success: false,
		error: "disable_all_refused",
	});
	expect(genSrtlaBondEntries().map(({ iface }) => iface)).toEqual([
		"eth0",
		second,
	]);
});

test("an acknowledged OFF stays at its connector across reload and kernel bus renumbering", async () => {
	await scan({ ...b, serial: "" });
	setPersistentBondOptOut(second, true);
	await reload();
	const newBus = "9";
	await scan({
		...b,
		busnum: newBus,
		readlink: b.readlink
			.replace(`/usb${b.busnum}/`, `/usb${newBus}/`)
			.replaceAll(`/${b.busnum}-`, `/${newBus}-`),
		udevadm: a.udevadm,
		serial: "0000",
		idProduct: "81d8",
	});
	expect(included(second)).toEqual([false]);
});

test("a clean v2026.11.4 save after rollback remains readable on roll forward", async () => {
	await writeFile(file, JSON.stringify(rollbackCleanSave));
	await reload();
	await scan({ ...a, serial: group1 }, { ...b, serial: group1 });
	expect(included(first, second)).toEqual([true, true]);
});
