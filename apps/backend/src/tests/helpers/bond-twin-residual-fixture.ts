import { afterEach, beforeEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call } from "@orpc/server";
import {
	getConfigFilePath,
	loadConfig,
	saveConfigInBackground,
	setConfigFilePath,
} from "../../modules/config.ts";
import { mintLinkId } from "../../modules/modems/physical-identity.ts";
import {
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOutSession,
	resetNetifSnapshotForTest,
} from "../../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	onUsbNetScanCommitted,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../../modules/network/router-cellular-scan.ts";
import { configureNetworkInterfaceProcedure } from "../../rpc/procedures/network.procedure.ts";
import { firstSightIfconfig } from "./bond-first-sight-fixture.ts";
import { makeRpcContext } from "./bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./constructed-usb-twins.ts";

export const [A, B] = constructedTwins;
if (!A || !B) throw new Error("missing constructed twin devices");
const SERIAL = "ConstructedBondTwin";
export const G = mintLinkId(`usb-serial:413c:${SERIAL}`);
export const P = mintLinkId("usb-serial:413c:0000");
const DIGEST = new Bun.CryptoHasher("sha256")
	.update(`413c:${SERIAL}`)
	.digest("hex");
export const ETH = { ifname: "eth0" };
const LAN = { ifname: "eth1" };
const IP: Readonly<Record<string, string>> = {
	[A.ifname]: "100.64.1.2",
	[B.ifname]: "100.64.2.2",
	eth0: "192.168.1.2",
	eth1: "192.168.2.2",
};
type Device = typeof A & { readonly product?: string };

export const twinA = { ...A, serial: SERIAL };
export const twinB = { ...B, serial: SERIAL };
export const movedA = { ...twinB, ifname: A.ifname };
export const newPortB = {
	...twinB,
	busnum: "5",
	devpath: "2",
	readlink: "/sys/devices/platform/usb5/5-2/5-2:1.0",
	udevadm: { ...B.udevadm, ID_PATH: "platform-fixture.usb-usb-0:2:1.0" },
};
export const placeholderB = { ...B, serial: "0000" };
export const noSerialB = { ...B, serial: "" };
export const singletonA = { ...A, serial: "ConstructedSingleton" };

let dir: string;
let configPath: string;
let originalPath: string;

export async function reload() {
	resetBondOptOutSession();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	await loadConfig();
}

export async function seed(groups: readonly string[], known = true) {
	await Bun.write(
		configPath,
		JSON.stringify({
			bond_opt_out: Object.fromEntries(groups.map((group) => [group, true])),
			...(known ? { usb_serial_shared: [DIGEST] } : {}),
		}),
	);
	await reload();
}

function ip(ifname: string): string {
	const value = IP[ifname];
	if (value === undefined) throw new Error(`missing fixture IP for ${ifname}`);
	return value;
}

export function attach(
	devices: readonly { ifname: string }[],
	pending?: string,
	builtIns = [ETH, LAN],
) {
	const names = [...devices, ...builtIns].map(({ ifname }) => ifname);
	processIfconfigOutput(
		names.map((name) => firstSightIfconfig(name, ip(name))).join("\n\n"),
		undefined,
		0,
		pending === undefined
			? undefined
			: new Map([
					[pending, { seen: 0, result: { kind: "unreadable", code: "EIO" } }],
				]),
	);
}

export const enabled = (...devices: readonly { ifname: string }[]) => {
	const wire = netIfBuildMsg();
	return devices.map(({ ifname }) => wire[ifname]?.enabled);
};

async function publishDevices(
	devices: readonly Device[],
	builtIns?: { ifname: string }[],
) {
	attach(devices, undefined, builtIns);
	const publications: ReturnType<typeof enabled>[] = [];
	const unsubscribe = onUsbNetScanCommitted(() => {
		publications.push(enabled(...devices));
	});
	try {
		const deps = constructedTwinDeps([...devices]);
		const productAttrs = new Map(
			devices.map((device) => [
				`${dirname(device.readlink)}/product`,
				device.product,
			]),
		);
		await refreshUsbNetMarkers(
			devices.map(({ ifname }) => ifname),
			{
				...deps,
				readAttr: (path) =>
					productAttrs.get(path) === undefined
						? deps.readAttr(path)
						: Promise.resolve(productAttrs.get(path)),
				...(defaultRouterCellularScanDeps.sharedSerials === undefined
					? {}
					: { sharedSerials: defaultRouterCellularScanDeps.sharedSerials }),
			},
		);
		return publications;
	} finally {
		unsubscribe();
	}
}

export function publish(...devices: Device[]) {
	return publishDevices(devices);
}

export async function plugDevices(
	devices: readonly Device[],
	builtIns?: { ifname: string }[],
) {
	const publications = await publishDevices(devices, builtIns);
	await saveConfigInBackground();
	return publications;
}

export function plug(...devices: Device[]) {
	return plugDevices(devices);
}

export async function toggle(
	device: { ifname: string },
	on: boolean,
	applied = on,
) {
	const { ifname } = device;
	const result = await call(
		configureNetworkInterfaceProcedure,
		{ name: ifname, ip: ip(ifname), enabled: on },
		{ context: makeRpcContext() },
	);
	expect(result).toMatchObject({
		success: true,
		applied: { enabled: applied },
	});
}

export function useBondTwinFixture() {
	beforeEach(async () => {
		originalPath = getConfigFilePath();
		dir = mkdtempSync(join(tmpdir(), "bond-twin-group-"));
		configPath = join(dir, "config.json");
		setConfigFilePath(configPath);
		await seed([]);
	});

	afterEach(async () => {
		await seed([], false);
		setConfigFilePath(originalPath);
		rmSync(dir, { recursive: true, force: true });
	});
	return { configPath: () => configPath, dir: () => dir };
}
