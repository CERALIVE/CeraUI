import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { getMockState, updateMockState } from "../mocks/mock-service.ts";
import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	listPhysicalDevices,
	mintLinkId,
	resetPhysicalIdentityRegistry,
} from "../modules/modems/physical-identity.ts";
import { describeModemBondKeys } from "../modules/modems/physical-identity-source.ts";
import {
	isBondOptedOut,
	resetSessionBondOptOutForTest,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import { createMonitorManager } from "../modules/network/monitor/monitor-manager.ts";
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
import { bootDevice, installDevice } from "./helpers/bond-guard-install.ts";
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

test.each([
	"mock",
	"overlay",
	"hwsim",
	"emulated",
	"scenario",
	"test",
] as const)(
	"%s persists only the historical bond config bytes",
	async (mode) => {
		const keys = [
			"NODE_ENV",
			"MOCK_MODE",
			"MOCK_SCENARIO",
			"HWSIM_REPO",
			"CERALIVE_DEVICE_TYPE",
		] as const;
		const saved = keys.map((key) => [key, process.env[key]] as const);
		const { initialized, netifConfigs } = getMockState();
		try {
			for (const key of keys) delete process.env[key];
			process.env.NODE_ENV = mode === "test" ? "test" : "production";
			process.env.CERALIVE_DEVICE_TYPE =
				mode === "emulated" ? "emulated" : "real";
			if (mode === "mock" || mode === "overlay") process.env.MOCK_MODE = "true";
			if (mode === "scenario") process.env.MOCK_SCENARIO = "multi-modem-wifi";
			if (mode === "hwsim") process.env.HWSIM_REPO = "/fixture";
			updateMockState({
				initialized: mode === "overlay",
				netifConfigs: new Map(),
			});
			await writeFile(file, "{}");
			await reload();
			const absent = async () => "";
			const observer = bootDevice({
				getDeviceTypeOverride: () => process.env.CERALIVE_DEVICE_TYPE,
				isDevelopment: () => false,
				readDeviceTreeCompatible: absent,
				readDeviceTreeModel: absent,
				readCeraliveRelease: absent,
				readDmiProductName: absent,
				readDmiBoardName: absent,
			});
			await observer.ready;
			installDevice(
				observer,
				createMonitorManager(() => undefined),
			);
			await scan({ ...b, serial: "" });
			addUplinks();
			getConfig().bond_opt_out = {
				[describeModemBondKeys(second).linkId]: true,
			};
			saveConfig();
			const mainBytes = await Bun.file(file).text();
			getConfig().bond_opt_out = undefined;
			saveConfig();
			expect(
				await call(
					configureNetworkInterfaceProcedure,
					{ name: second, ip: "198.51.100.2", enabled: false },
					{ context: makeRpcContext() },
				),
			).toMatchObject({ success: true, applied: { enabled: false } });
			expect(await Bun.file(file).text()).toBe(mainBytes);
		} finally {
			updateMockState({ initialized, netifConfigs });
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	},
);

function onPci(device: Device, port: string, serial: string): Device {
	return {
		...device,
		serial,
		busnum: "1",
		devpath: port,
		readlink: `/sys/devices/pci0000:00/0000:00:14.0/usb1/1-${port}/1-${port}:1.0`,
		udevadm: {
			...device.udevadm,
			ID_PATH: `pci-0000:00:14.0-usb-0:${port}:1.0`,
		},
	};
}

test("ON does not erase an OFF projected by another connector at the reused label", async () => {
	const original = { ...b, serial: "" };
	const relabeledA = { ...a, serial: "", udevadm: b.udevadm };
	const relabeledB = { ...original, udevadm: a.udevadm };
	await scan(original);
	const legacy = describeModemBondKeys(second).linkId;
	setPersistentBondOptOut(second, true);
	await scan(relabeledA, relabeledB);
	setPersistentBondOptOut(first, true);
	setPersistentBondOptOut(second, false);
	await reload();
	await scan(relabeledA, relabeledB);
	expect(included(first, second)).toEqual([false, true]);
	expect(getConfig().bond_opt_out?.[legacy]).toBe(true);
});

test("an unrelated Dell serial history and exact OFF do not veto a Huawei fallback", async () => {
	await writeFile(file, "{}");
	await reload();
	await scan({ ...a, serial: "CONSTRUCTED-DELL-EXACT" });
	setPersistentBondOptOut(first, true);
	getConfig().usb_serial_shared = [
		new Bun.CryptoHasher("sha256").update(`413c:${group1}`).digest("hex"),
	];
	await scan({ ...b, idVendor: "12d1", idProduct: "1506", serial: "" });
	addUplinks();
	expect(await realDevice(turnEthernetOff)).toMatchObject({ success: true });
	expect(genSrtlaBondEntries().map(({ iface }) => iface)).toEqual([second]);
});

test("a confirmed ON transfers to the same-brand replacement from a different pair", async () => {
	await scan({ ...a, serial: group1 }, { ...b, serial: group1 });
	setPersistentBondOptOut(second, false);
	await reload();
	await scan({ ...a, serial: group2 }, { ...b, serial: group2 });
	expect(included(first, second)).toEqual([false, true]);
});

test("a PCI ON preserves the pair default for a sibling unseen at the write", async () => {
	const twinA = onPci(a, "3", group1);
	const twinB = onPci(b, "4", group1);
	await scan(twinB);
	setPersistentBondOptOut(second, false);
	await reload();
	await scan(twinA, twinB);
	expect(included(first, second)).toEqual([false, true]);
});

test("an excluded PCI twin can be turned on through the RPC and stays in after restart", async () => {
	const twins = [onPci(a, "3", group1), onPci(b, "4", group1)];
	await scan(...twins);
	addUplinks();
	expect(included(first, second)).toEqual([false, false]);
	expect(
		await call(
			configureNetworkInterfaceProcedure,
			{ name: second, ip: "198.51.100.2", enabled: true },
			{ context: makeRpcContext() },
		),
	).toEqual({
		success: true,
		applied: { name: second, ip: "198.51.100.2", enabled: true },
	});
	await reload();
	await scan(...twins);
	expect(included(first, second)).toEqual([false, true]);
});

test("an empty config still allows a serial-less PCI USB modem as the sole fallback", async () => {
	await writeFile(file, "{}");
	await reload();
	await scan(onPci(b, "4", ""));
	addUplinks();
	expect(await realDevice(turnEthernetOff)).toMatchObject({ success: true });
	expect(genSrtlaBondEntries().map(({ iface }) => iface)).toEqual([second]);
});

test("an unreadable-mode ON does not erase a known unique-serial OFF", async () => {
	const unique = { ...b, serial: "CONSTRUCTED-UNIQUE-SERIAL" };
	await scan(unique);
	setPersistentBondOptOut(second, true);
	await scan({ ...unique, serial: "", idProduct: "81d8" });
	setPersistentBondOptOut(second, false);
	await reload();
	await scan(unique);
	expect(included(second)).toEqual([false]);
});

test("bond reads still register the resolved physical link", async () => {
	await scan({ ...b, serial: "CONSTRUCTED-REGISTRY-SERIAL" });
	const expected = describeModemBondKeys(second).linkId;
	resetPhysicalIdentityRegistry();
	isBondOptedOut(second);
	expect(listPhysicalDevices().map(({ linkId }) => linkId)).toEqual([expected]);
});

test.each(["", "CONSTRUCTED-HUAWEI-UNIQUE"])(
	"a connector OFF is legacy-readable but does not apply to another vendor with serial %j",
	async (serial) => {
		await writeFile(file, "{}");
		await reload();
		await scan({ ...b, serial: "" });
		const exact = describeModemBondKeys(second).linkId;
		setPersistentBondOptOut(second, true);
		expect(included(second)).toEqual([false]);
		await reload();
		await scan({ ...b, idVendor: "12d1", idProduct: "1506", serial });
		expect(included(second)).toEqual([true]);
		await scan({ ...b, serial: "" });
		expect(included(second)).toEqual([false]);
		expect(getConfig().bond_opt_out?.[exact]).toBe(true);
	},
);

test("an unrelated exact OFF does not make a serial-less modem an uncertain fallback", async () => {
	await writeFile(file, "{}");
	await reload();
	await scan({ ...a, serial: "CONSTRUCTED-EXACT-ONLY" });
	setPersistentBondOptOut(first, true);
	await scan({ ...b, serial: "" });
	addUplinks();
	expect(await realDevice(turnEthernetOff)).toMatchObject({ success: true });
	expect(genSrtlaBondEntries().map(({ iface }) => iface)).toEqual([second]);
});

test("turning on a connector keeps an absent modem's unrelated legacy exact OFF", async () => {
	const unique = { ...a, serial: "CONSTRUCTED-UNRELATED-OFF" };
	await scan(unique);
	const exact = describeModemBondKeys(first).linkId;
	setPersistentBondOptOut(first, true);
	await scan({ ...b, serial: "" });
	setPersistentBondOptOut(second, false);
	await reload();
	await scan(unique, { ...b, serial: "" });
	expect(included(first, second)).toEqual([false, true]);
	expect(getConfig().bond_opt_out?.[exact]).toBe(true);
});

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

test("an unreadable port without pair proof keeps the main fallback behavior", async () => {
	await scan({ ...b, serial: "" });
	addUplinks();
	expect(await realDevice(turnEthernetOff)).toMatchObject({ success: true });
	expect(genSrtlaBondEntries().map(({ iface }) => iface)).toEqual([second]);
});

test("an unreadable port with a proved pair default cannot justify disabling the only known uplink", async () => {
	await scan({ ...a, serial: group1 }, { ...b, serial: group1 });
	setPersistentBondOptOut(first, true);
	await reload();
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
