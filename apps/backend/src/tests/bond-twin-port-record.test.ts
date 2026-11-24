import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { updateMockState } from "../mocks/mock-service.ts";
import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { describeModemBondKeys } from "../modules/modems/physical-identity-source.ts";
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
	defaultRouterCellularScanDeps,
	getUsbPhysicalDescriptor,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";
import { observeRealDeviceAtBoot } from "../modules/system/device-detection.ts";
import { buildMsg } from "../rpc/compat.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	clearBondNetworkFixture,
	makeRpcContext,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const [g1, g2, huawei] = ["PORT-RECORD-G1", "PORT-RECORD-G2", "PORT-RECORD-HW"];
const pairKey = (vid: string, serial: string) =>
	mintLinkId(`usb-serial:${vid}:${serial}`);
const digest = (vid: string, serial: string) =>
	new Bun.CryptoHasher("sha256").update(`${vid}:${serial}`).digest("hex");
const G1 = pairKey("413c", g1);
const G2 = pairKey("413c", g2);
const PLACEHOLDER = pairKey("413c", "0000");
const [a, b] = constructedTwins;
if (a === undefined || b === undefined) throw new Error("Expected two ports");
const [first, second] = [a.ifname, b.ifname];
type Device = (typeof constructedTwins)[number];
const at = (device: Device, serial: string, idProduct = device.idProduct) => ({
	...device,
	serial,
	idProduct,
});
let directory: string;
let file: string;

async function start(config: object) {
	await writeFile(file, JSON.stringify(config));
	await reload();
}

const pairs = (...keys: string[]) => ({
	bond_opt_out: Object.fromEntries(keys.map((key) => [key, true])),
	usb_serial_shared: [digest("413c", g1), digest("413c", g2)],
});

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bond-port-record-"));
	file = join(directory, "config.json");
	setConfigFilePath(file);
	await start(pairs(G1, G2));
});

afterEach(async () => {
	setBondDisableGuardContext(undefined, false);
	clearBondNetworkFixture();
	resetUsbNetMarkers();
	resetSessionBondOptOutForTest();
	setConfigFilePath("config.json");
	await rm(directory, { recursive: true, force: true });
});

async function scan(...devices: Device[]) {
	await refreshUsbNetMarkers(
		devices.map(({ ifname }) => ifname),
		{
			...constructedTwinDeps(devices),
			sharedSerials: defaultRouterCellularScanDeps.sharedSerials,
		},
	);
}

async function readOnlyScan(...devices: Device[]) {
	const bytes = await Bun.file(file).text();
	await scan(...devices);
	expect(await Bun.file(file).text()).toBe(bytes);
}

async function reload() {
	resetSessionBondOptOutForTest();
	resetUsbNetMarkers();
	await loadConfig();
}

const included = (...names: string[]) =>
	names.map((name) => !isBondOptedOut(name));
const portId = (device: Device) => describeModemBondKeys(device.ifname).linkId;

function addUplinks(other?: string) {
	for (const [name, ip] of [
		["eth0", "192.0.2.1"],
		[second, "198.51.100.2"],
		...(other === undefined ? [] : ([[other, "198.51.100.3"]] as const)),
	] as const) {
		getNetworkInterfaces()[name] = {
			ip,
			netmask: "255.255.255.0",
			enabled: true,
			error: 0,
			tp: 0,
			txb: 0,
			rxb: 0,
			...(name !== "eth0" ? { usb: true, identitySettled: true } : {}),
		};
	}
}

async function onRealDevice<T>(action: () => Promise<T>): Promise<T> {
	const keys = ["NODE_ENV", "MOCK_MODE", "MOCK_SCENARIO", "HWSIM_REPO"];
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

const configure = (name: string, ip: string, enabled: boolean) =>
	call(
		configureNetworkInterfaceProcedure,
		{ name, ip, enabled },
		{ context: makeRpcContext() },
	);
const senders = () => genSrtlaBondEntries().map(({ iface }) => iface);

test.each([
	["R5b-A: OFF then ON while the serial is unreadable", "", "81d7", false],
	["R5b-A: OFF while visible, ON while unreadable", "", "81d7", true],
	["R5-H1: ON in another USB mode", "", "81d8", true],
	["ON while the twin reports the 0000 placeholder", "0000", "81d7", false],
] as const)(
	"%s survives restart and the serial returning",
	async (_name, serial, mode, visibleOff) => {
		if (visibleOff) {
			await scan(at(b, g1));
			setPersistentBondOptOut(second, true);
		}
		await scan(at(b, serial, mode));
		if (!visibleOff) setPersistentBondOptOut(second, true);
		setPersistentBondOptOut(second, false);
		await reload();
		await readOnlyScan(at(b, serial, mode));
		expect(included(second)).toEqual([true]);
		await readOnlyScan(at(a, g1), at(b, g1));
		expect(included(first, second)).toEqual([false, true]);
		await reload();
		await readOnlyScan(at(b, g1), at(a, g1));
		expect(included(first, second)).toEqual([false, true]);
	},
);

test("R5b-A strand: an ON twin stays the sole sender when its serial returns", async () => {
	await onRealDevice(async () => {
		await scan(at(b, ""));
		addUplinks();
		setPersistentBondOptOut(second, true);
		setPersistentBondOptOut(second, false);
		expect(await configure("eth0", "192.0.2.1", false)).toMatchObject({
			success: true,
		});
		await readOnlyScan(at(b, g1));
		expect(senders()).toEqual([second]);
	});
});

test("R5b-S: a group-less ON follows the same-brand port into another pair", async () => {
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(second, true);
	await scan(at(b, "", "81d8"));
	setPersistentBondOptOut(second, false);
	await reload();
	await readOnlyScan(at(a, g2), at(b, g2));
	expect(included(first, second)).toEqual([false, true]);
});

test("a same-brand replacement at an ON port inherits it, even from a confirmed pair", async () => {
	await scan(at(a, g1), at(b, g1));
	addUplinks();
	expect(
		await onRealDevice(() => configure(second, "198.51.100.2", true)),
	).toEqual({
		success: true,
		applied: { name: second, ip: "198.51.100.2", enabled: true },
	});
	await reload();
	await readOnlyScan(at(a, g2), at(b, g2));
	expect(included(first, second)).toEqual([false, true]);
});

test.each([
	["an unplugged sibling", false],
	["an OFF on the excluded twin with its sibling unplugged", true],
] as const)("F2-H1: %s stays excluded when it returns", async (_name, off) => {
	await scan(at(a, g1));
	setPersistentBondOptOut(first, off);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([!off, false]);
});

test("possible twins showing the 0000 placeholder keep their own choices", async () => {
	await start(pairs(PLACEHOLDER));
	await scan(at(a, "0000"));
	setPersistentBondOptOut(first, false);
	await reload();
	await readOnlyScan(at(a, "0000"), at(b, "0000"));
	expect(included(first, second)).toEqual([true, false]);
	await readOnlyScan(at(b, "0000"));
	expect(included(second)).toEqual([true]);
});

test("toggling a sibling keeps an ON twin in and writes main's legacy bytes", async () => {
	await scan(at(b, ""));
	setPersistentBondOptOut(second, false);
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(first, false);
	expect(JSON.stringify(getConfig().bond_opt_out)).toBe(
		JSON.stringify({ [G2]: true, [portId(b)]: true }),
	);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([true, true]);
	setPersistentBondOptOut(second, true);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([true, false]);
});

test("a readable unique-serial OFF beats and clears the same port's ON", async () => {
	await scan(at(b, ""));
	setPersistentBondOptOut(second, false);
	await scan(at(b, "PORT-RECORD-UNIQUE"));
	setPersistentBondOptOut(second, true);
	expect(getConfig().bond_opt_in).toBeUndefined();
	await reload();
	await readOnlyScan(at(b, "PORT-RECORD-UNIQUE"));
	expect(included(second)).toEqual([false]);
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([false, false]);
});

test("a path change loses the port's ON and falls back to the pair default", async () => {
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(second, false);
	const relabelled = {
		...at(b, g1),
		udevadm: { ...b.udevadm, ID_PATH: "platform-fc400000.usb-usb-0:2:1.0" },
	};
	await readOnlyScan(at(a, g1), relabelled);
	expect(included(first, second)).toEqual([false, false]);
});

test("a port ON does not transfer to a different brand's excluded pair", async () => {
	await start({
		...pairs(G1, pairKey("12d1", huawei)),
		usb_serial_shared: [digest("413c", g1), digest("12d1", huawei)],
	});
	await scan(at(b, ""));
	setPersistentBondOptOut(second, false);
	const other = (device: Device) => ({
		...at(device, huawei),
		idVendor: "12d1",
		idProduct: "1506",
	});
	await readOnlyScan(other(a), other(b));
	expect(included(first, second)).toEqual([false, false]);
});

test("an ON from another vendor at an aliased path keeps the attached twin ON", async () => {
	const alias = {
		...at(b, ""),
		idVendor: "1e0e",
		udevadm: { ...b.udevadm, ID_PATH: a.udevadm.ID_PATH },
	};
	await scan(at(a, g1), alias);
	setPersistentBondOptOut(first, false);
	expect(included(first)).toEqual([true]);
	setPersistentBondOptOut(second, false);
	expect(included(first, second)).toEqual([true, true]);
});

test("an ON from a different vendor does not erase the previous vendor's port ON", async () => {
	await scan(at(a, g1), at(b, g1));
	setPersistentBondOptOut(first, false);
	expect(included(first, second)).toEqual([true, false]);
	await scan({ ...at(a, ""), idVendor: "1e0e" }, at(b, g1));
	setPersistentBondOptOut(first, false);
	await reload();
	await readOnlyScan(at(a, g1), at(b, g1));
	expect(included(first, second)).toEqual([true, false]);
});

test.each([
	["its own unique serial", "PORT-RECORD-HUAWEI-UNIQUE", true],
	["no serial", "", true],
] as const)(
	"a port OFF leaves another brand with %s IN",
	async (_name, serial, expected) => {
		await start({});
		await scan(at(b, ""));
		addUplinks();
		expect(
			await onRealDevice(() => configure(second, "198.51.100.2", false)),
		).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		const previousPort = portId(b);
		await reload();
		await readOnlyScan({
			...at(b, serial),
			idVendor: "12d1",
			idProduct: "1506",
		});
		expect(included(second)).toEqual([expected]);
		expect(getConfig().bond_opt_out).toEqual({ [previousPort]: true });
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([false]);
	},
);

test("an acknowledged ON carries over to a lone same-brand 0000 replacement", async () => {
	await onRealDevice(async () => {
		await start(pairs(G1, PLACEHOLDER));
		await scan(at(b, g1));
		addUplinks();
		expect(await configure(second, "198.51.100.2", true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		await reload();
		await readOnlyScan(at(b, "0000"));
		expect(included(second)).toEqual([true]);
		expect(senders()).toContain(second);
	});
});

test("an acknowledged unique-serial OFF survives restart with an unreadable serial", async () => {
	await onRealDevice(async () => {
		await start({});
		await scan(at(b, "PORT-RECORD-UNIQUE"));
		addUplinks();
		const serialKey = portId(b);
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([false]);
		expect(senders()).toEqual(["eth0"]);
		expect(JSON.stringify((await Bun.file(file).json()).bond_opt_out)).toBe(
			JSON.stringify({ [serialKey]: true, [portId(b)]: true }),
		);
	});
});

const huaweiAt = (device: Device, serial = "") => ({
	...at(device, serial),
	idVendor: "12d1",
	idProduct: "1506",
});

test("the first cross-vendor aliased OFF cannot bypass the last-uplink refusal", async () => {
	await onRealDevice(async () => {
		await start({});
		const x = {
			...huaweiAt(a),
			ifname: "wwx0",
			udevadm: b.udevadm,
		};
		await readOnlyScan(at(b, ""), x);
		expect(portId(x)).toBe(portId(b));
		addUplinks(x.ifname);
		expect(await configure("eth0", "192.0.2.1", false)).toMatchObject({
			success: true,
		});
		const bytes = await Bun.file(file).text();
		expect(await configure(x.ifname, "198.51.100.3", false)).toEqual({
			success: false,
			error: "disable_all_refused",
		});
		expect(senders()).toEqual([second, x.ifname]);
		expect(await Bun.file(file).text()).toBe(bytes);
	});
});

test("acknowledged OFF records at one port survive another vendor's OFF", async () => {
	await onRealDevice(async () => {
		await start({});
		addUplinks();
		await scan(at(b, ""));
		const port = portId(b);
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		await readOnlyScan(huaweiAt(b));
		expect(included(second)).toEqual([true]);
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		await reload();
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([false]);
		await readOnlyScan(huaweiAt(b));
		expect(included(second)).toEqual([false]);
		expect(getConfig().bond_opt_out).toEqual({ [port]: true });
	});
});

test("an acknowledged port OFF remains effective when the same modem reports a unique serial", async () => {
	await onRealDevice(async () => {
		await start({});
		await scan(at(b, ""));
		addUplinks();
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		const port = portId(b);
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		const readable = at(b, "PORT-OFF-BECOMES-UNIQUE");
		await readOnlyScan(readable);
		expect(describeModemBondKeys(second).anchor).toBe("usb-serial");
		expect(senders()).toEqual(["eth0"]);
		expect(await configure(second, "198.51.100.2", true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		await reload();
		await readOnlyScan(at(b, ""));
		expect(included(second)).toEqual([true]);
		expect(getConfig().bond_opt_out).toEqual({ [port]: true });
	});
});

test("a vendor-unknown legacy port OFF still applies to an unreadable replacement", async () => {
	await scan(at(b, ""));
	const port = portId(b);
	await start({ bond_opt_out: { [port]: true } });
	await readOnlyScan(huaweiAt(b));
	expect(included(second)).toEqual([false]);
});

test.each(["", "UNIQUE-REPLACEMENT"])(
	"another vendor's OFF with serial %j does not take ownership of an unknown legacy exclusion",
	async (serial) => {
		await onRealDevice(async () => {
			await scan(at(b, ""));
			const port = portId(b);
			await start({ bond_opt_out: { [port]: true } });
			addUplinks();
			const replacement = { ...at(b, serial), idVendor: "1e0e" };
			await readOnlyScan(replacement);
			expect(included(second)).toEqual([serial !== ""]);
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			await reload();
			await readOnlyScan(at(b, ""));
			expect(included(second)).toEqual([false]);
			expect(senders()).toEqual(["eth0"]);
			await readOnlyScan(huaweiAt(b));
			expect(included(second)).toEqual([false]);
			expect(getConfig().bond_opt_out?.[port]).toBe(true);
		});
	},
);

test("a serial OFF appends a rollback bit without disturbing legacy order, and ON clears only its own extra bit", async () => {
	await onRealDevice(async () => {
		const legacy = { [G2]: true, [G1]: true } as const;
		await start({ bond_opt_out: legacy });
		await scan(at(b, ""));
		const port = portId(b);
		const readable = at(b, "PORT-OFF-ROLLBACK");
		await scan(readable);
		const serial = portId(b);
		addUplinks();
		expect(await configure(second, "198.51.100.2", false)).toMatchObject({
			success: true,
			applied: { enabled: false },
		});
		expect(JSON.stringify((await Bun.file(file).json()).bond_opt_out)).toBe(
			JSON.stringify({ ...legacy, [serial]: true, [port]: true }),
		);
		await reload();
		clearBondNetworkFixture();
		addUplinks();
		await readOnlyScan(huaweiAt(b));
		expect(included(second)).toEqual([true]);
		await readOnlyScan(readable);
		expect(await configure(second, "198.51.100.2", true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		expect(JSON.stringify(getConfig().bond_opt_out)).toBe(
			JSON.stringify(legacy),
		);
	});
});

test("auto-detected emulation saves only the exact legacy OFF bytes", async () => {
	await onRealDevice(async () => {
		const forced = process.env.CERALIVE_DEVICE_TYPE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		try {
			const absent = async () => "";
			const observer = observeRealDeviceAtBoot(false, {
				isDevelopment: () => false,
				getDeviceTypeOverride: () => process.env.CERALIVE_DEVICE_TYPE,
				readDeviceTreeCompatible: absent,
				readDeviceTreeModel: absent,
				readCeraliveRelease: absent,
				readDmiProductName: absent,
				readDmiBoardName: absent,
			});
			expect(await observer.ready).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(observer.isStillReal()).toBe(false);
			setBondDisableGuardContext(observer, true);
			await start({});
			await scan(at(b, ""));
			addUplinks();
			const port = portId(b);
			// Capture the legacy writer's full file, including defaults and ordering.
			setPersistentBondOptOut(second, true, "legacy");
			const expected = await Bun.file(file).text();
			expect(getConfig().bond_opt_out).toEqual({ [port]: true });
			await start({});
			await scan(at(b, ""));
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			expect(await Bun.file(file).text()).toBe(expected);
		} finally {
			if (forced !== undefined) process.env.CERALIVE_DEVICE_TYPE = forced;
		}
	});
});

test("auto-emulation honors ON after an OFF made while boot evidence was pending", async () => {
	await onRealDevice(async () => {
		const forced = process.env.CERALIVE_DEVICE_TYPE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		const evidence = Promise.withResolvers<string>();
		try {
			await start({});
			await scan(at(b, ""));
			addUplinks();
			const absent = async () => "";
			const observer = observeRealDeviceAtBoot(false, {
				isDevelopment: () => false,
				getDeviceTypeOverride: () => undefined,
				readDeviceTreeCompatible: () => evidence.promise,
				readDeviceTreeModel: absent,
				readCeraliveRelease: absent,
				readDmiProductName: absent,
				readDmiBoardName: absent,
			});
			setBondDisableGuardContext(observer, true);
			expect(observer.isStillReal()).toBe(true);
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			evidence.resolve("");
			expect(await observer.ready).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(observer.isStillReal()).toBe(false);
			expect(await configure(second, "198.51.100.2", true)).toMatchObject({
				success: true,
				applied: { enabled: true },
			});
			expect(senders()).toEqual(["eth0", second]);
			await reload();
			await readOnlyScan(at(b, ""));
			expect(senders()).toEqual(["eth0", second]);
		} finally {
			evidence.resolve("");
			if (forced !== undefined) process.env.CERALIVE_DEVICE_TYPE = forced;
		}
	});
});

test.each(["", "UNIQUE-BEFORE-EMULATION"])(
	"an emulated boot can undo a prior real OFF with serial %j",
	async (serial) => {
		await onRealDevice(async () => {
			const forced = process.env.CERALIVE_DEVICE_TYPE;
			delete process.env.CERALIVE_DEVICE_TYPE;
			try {
				await start({});
				await scan(at(b, serial));
				addUplinks();
				expect(await configure(second, "198.51.100.2", false)).toMatchObject({
					success: true,
					applied: { enabled: false },
				});
				process.env.CERALIVE_DEVICE_TYPE = "emulated";
				await reload();
				await readOnlyScan(at(b, serial));
				expect(await configure(second, "198.51.100.2", true)).toMatchObject({
					success: true,
					applied: { enabled: true },
				});
				expect(senders()).toEqual(["eth0", second]);
				await reload();
				await readOnlyScan(at(b, serial));
				expect(senders()).toEqual(["eth0", second]);
				delete process.env.CERALIVE_DEVICE_TYPE;
				await reload();
				await readOnlyScan(at(b, serial));
				expect(senders()).toEqual(["eth0", second]);
			} finally {
				if (forced === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
				else process.env.CERALIVE_DEVICE_TYPE = forced;
			}
		});
	},
);

test("persisting newly seen shared serial history does not restore stale bond preferences", async () => {
	await start({ bond_opt_out: { [G1]: true } });
	const newTwins = [at(a, "PORT-RECORD-NEW"), at(b, "PORT-RECORD-NEW")];
	const replacement = { bond_opt_out: { [G2]: true }, max_br: 4321 };
	await writeFile(file, JSON.stringify(replacement));
	await refreshUsbNetMarkers([first, second], {
		...defaultRouterCellularScanDeps,
		...constructedTwinDeps(newTwins),
	});
	expect(await Bun.file(file).json()).toEqual({
		...replacement,
		usb_serial_shared: [digest("413c", "PORT-RECORD-NEW")],
	});
});

test("a newly attached twin publishes on retry after a history write fails", async () => {
	await start({});
	await scan(at(a, g1));
	expect(getUsbPhysicalDescriptor(first)).toBeDefined();
	// Block the real atomic writer's temporary file, even when running as root.
	await mkdir(join(directory, `.config.json.${process.pid}.tmp`));
	await scan(at(a, g1), at(b, g1));
	expect(getUsbPhysicalDescriptor(second)).toBeUndefined();
	await scan(at(a, g1), at(b, g1));
	expect(getUsbPhysicalDescriptor(second)).toBeDefined();
	expect(await Bun.file(file).text()).toBe("{}");
});

test.each(["", "PORT-WIRE-UNIQUE"])(
	"real USB OFF with serial %j leaves the config frame in main's format",
	async (serial) => {
		await onRealDevice(async () => {
			await start({});
			await scan(at(b, serial));
			addUplinks();
			const expected = {
				...getConfig(),
				bond_opt_out: { [portId(b)]: true },
			};
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			expect(buildMsg("config", getConfig())).toBe(
				JSON.stringify({ config: expected }),
			);
		});
	},
);

test.each([
	["mock", "production", "true", undefined, undefined, "real", false],
	["overlay", "production", "true", undefined, undefined, "real", true],
	["hwsim", "production", undefined, undefined, "/fixture", "real", false],
	[
		"emulated",
		"production",
		undefined,
		undefined,
		undefined,
		"emulated",
		false,
	],
	[
		"scenario",
		"production",
		undefined,
		"multi-modem-wifi",
		undefined,
		"real",
		false,
	],
	["test", "test", undefined, undefined, undefined, "real", false],
] as const)(
	"serial-less non-twin OFF/ON restores the exact saved bytes in %s",
	async (_mode, node, mock, scenario, hwsim, device, overlay) => {
		const env = {
			NODE_ENV: node,
			MOCK_MODE: mock,
			MOCK_SCENARIO: scenario,
			HWSIM_REPO: hwsim,
			CERALIVE_DEVICE_TYPE: device,
		};
		const before = Object.keys(env).map(
			(key) => [key, process.env[key]] as const,
		);
		try {
			for (const [key, value] of Object.entries(env)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			updateMockState({ initialized: overlay, netifConfigs: new Map() });
			await start({});
			saveConfig();
			const initial = await Bun.file(file).text();
			await scan(at(b, ""));
			addUplinks();
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			expect(await configure(second, "198.51.100.2", true)).toMatchObject({
				success: true,
				applied: { enabled: true },
			});
			expect(await Bun.file(file).text()).toBe(initial);
		} finally {
			updateMockState({ initialized: false, netifConfigs: new Map() });
			for (const [key, value] of before) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	},
);

test.each(["restored ON", "untouched exclusion"] as const)(
	"the guard refuses to disable the Huawei alongside a twin with %s",
	async (scenario) => {
		const x = onPci(
			{ ...b, ifname: "wwx0", idVendor: "12d1", idProduct: "1506" },
			"4",
			"PORT-RECORD-HUAWEI-UNIQUE",
		);
		await onRealDevice(async () => {
			if (scenario === "restored ON") {
				await scan(at(b, ""), x);
				addUplinks(x.ifname);
				expect(await configure(second, "198.51.100.2", true)).toMatchObject({
					success: true,
				});
				await scan(at(b, g1), x);
			} else {
				await scan(at(b, g1));
				addUplinks();
				expect(await configure(second, "198.51.100.2", false)).toMatchObject({
					success: true,
				});
				await reload();
				clearBondNetworkFixture();
				await scan(at(a, g1), x);
				addUplinks(x.ifname);
				delete getNetworkInterfaces()[second];
			}
			expect(await configure("eth0", "192.0.2.1", false)).toMatchObject({
				success: true,
			});
			expect(await configure(x.ifname, "198.51.100.3", false)).toEqual({
				success: false,
				error: "disable_all_refused",
			});
			expect(senders()).toContain(x.ifname);
		});
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

test.each([
	["both twins attached", true],
	["the sibling unplugged", false],
] as const)(
	"F1: a PCI twin turned ON through the RPC with %s stays in after restart",
	async (_name, both) => {
		const twins = [onPci(a, "3", g1), onPci(b, "4", g1)] as const;
		await scan(...(both ? twins : [twins[1]]));
		addUplinks();
		expect(
			await onRealDevice(() => configure(second, "198.51.100.2", true)),
		).toEqual({
			success: true,
			applied: { name: second, ip: "198.51.100.2", enabled: true },
		});
		await reload();
		await readOnlyScan(...twins);
		expect(included(first, second)).toEqual([false, true]);
	},
);

test("F2: an empty config still allows a serial-less PCI modem as the sole fallback", async () => {
	await start({});
	await scan(onPci(b, "4", ""));
	addUplinks();
	expect(
		await onRealDevice(() => configure("eth0", "192.0.2.1", false)),
	).toMatchObject({ success: true });
	expect(senders()).toEqual([second]);
});
