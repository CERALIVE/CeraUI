import { afterEach, beforeEach, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { loadConfig, setConfigFilePath } from "../../modules/config.ts";
import { mintLinkId } from "../../modules/modems/physical-identity.ts";
import { describeModemBondKeys } from "../../modules/modems/physical-identity-source.ts";
import {
	isBondOptedOut,
	resetSessionBondOptOutForTest,
} from "../../modules/network/bond-preference.ts";
import {
	getNetworkInterfaces,
	setBondDisableGuardContext,
} from "../../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../../modules/network/router-cellular-scan.ts";
import { genSrtlaBondEntries } from "../../modules/streaming/srtla.ts";
import { configureNetworkInterfaceProcedure } from "../../rpc/procedures/network.procedure.ts";
import {
	clearBondNetworkFixture,
	makeRpcContext,
} from "./bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./constructed-usb-twins.ts";

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

export function installBondPortFixture() {
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
}

async function scan(...devices: Device[]) {
	const { sharedSerials } = defaultRouterCellularScanDeps;
	if (sharedSerials === undefined)
		throw new Error("Missing USB serial history");
	await refreshUsbNetMarkers(
		devices.map(({ ifname }) => ifname),
		{
			...constructedTwinDeps(devices),
			sharedSerials,
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
			{ isStillReal: () => true, refresh: () => undefined },
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

export type { Device };
export {
	a,
	addUplinks,
	at,
	b,
	configure,
	digest,
	directory,
	file,
	first,
	G1,
	G2,
	g1,
	g2,
	huawei,
	included,
	onRealDevice,
	PLACEHOLDER,
	pairKey,
	pairs,
	portId,
	readOnlyScan,
	reload,
	scan,
	second,
	senders,
	start,
};
