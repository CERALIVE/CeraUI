import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import {
	getConfigFilePath,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { persistEthernetRole } from "../modules/network/ethernet-role.ts";
import {
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOutSession,
	resetNetifSnapshotForTest,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	onUsbNetScanCommitted,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import { firstSightIfconfig } from "./helpers/bond-first-sight-fixture.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const [A, B] = constructedTwins;
if (!A || !B) throw new Error("missing constructed twin devices");
const SERIAL = "ConstructedBondTwin";
const G = mintLinkId(`usb-serial:413c:${SERIAL}`);
const P = mintLinkId("usb-serial:413c:0000");
const DIGEST = new Bun.CryptoHasher("sha256")
	.update(`413c:${SERIAL}`)
	.digest("hex");
const ETH = { ifname: "eth0" };
const LAN = { ifname: "eth1" };
const IP: Readonly<Record<string, string>> = {
	[A.ifname]: "100.64.1.2",
	[B.ifname]: "100.64.2.2",
	eth0: "192.168.1.2",
	eth1: "192.168.2.2",
};
type Device = typeof A;

const twinA = { ...A, serial: SERIAL };
const twinB = { ...B, serial: SERIAL };
const movedA = { ...twinB, ifname: A.ifname };
const newPortB = {
	...twinB,
	busnum: "5",
	devpath: "2",
	readlink: "/sys/devices/platform/usb5/5-2/5-2:1.0",
	udevadm: { ...B.udevadm, ID_PATH: "platform-fixture.usb-usb-0:2:1.0" },
};
const placeholderB = { ...B, serial: "0000" };
const noSerialB = { ...B, serial: "" };
const singletonA = { ...A, serial: "ConstructedSingleton" };

let dir: string;
let configPath: string;
let originalPath: string;

async function reload() {
	resetBondOptOutSession();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	await loadConfig();
}

async function seed(groups: readonly string[], known = true) {
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

function attach(
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

const enabled = (...devices: readonly { ifname: string }[]) => {
	const wire = netIfBuildMsg();
	return devices.map(({ ifname }) => wire[ifname]?.enabled);
};

async function plug(...devices: Device[]) {
	attach(devices);
	const publications: ReturnType<typeof enabled>[] = [];
	const unsubscribe = onUsbNetScanCommitted(() => {
		publications.push(enabled(...devices));
	});
	try {
		await refreshUsbNetMarkers(
			devices.map(({ ifname }) => ifname),
			{
				...constructedTwinDeps(devices),
				sharedSerials: defaultRouterCellularScanDeps.sharedSerials,
			},
		);
		return publications;
	} finally {
		unsubscribe();
	}
}

async function toggle(device: { ifname: string }, on: boolean, applied = on) {
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

test("T1 / S1: after A-only enable and reload, the first scan publication excludes returning B", async () => {
	await seed([G]);
	await plug(twinA);
	expect(enabled(twinA)).toEqual([false]);
	await toggle(twinA, true);
	await reload();

	const publications = await plug(twinA, twinB);
	expect(resolveModemPhysicalIdentity(B.ifname).legacyLinkId).toBe(G);
	expect(publications).toEqual([[true, false]]);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});

test("T2 / S3: the absent sibling returns at a port it never used", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();
	await plug(newPortB);
	expect(enabled(newPortB)).toEqual([false]);
});

test("T3 / S2: keeps B excluded when the twins were first recognized before A's enable", async () => {
	await seed([G], false);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([false, false]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});

test("T4 / S18: explicitly enabling the sibling keeps both enabled after rescan and reload", async () => {
	await seed([G]);
	await plug(twinA, twinB);
	await toggle(twinA, true);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
	await toggle(twinB, true);
	await plug(twinA);
	await reload();
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, true]);
});

test("S23: a durable disable under another identity revokes the old group enable at that port", async () => {
	await seed([P]);
	await plug(placeholderB);
	expect(enabled(placeholderB)).toEqual([false]);
	await toggle(placeholderB, true);
	await plug(noSerialB);
	await toggle(noSerialB, false);
	await reload();
	await plug(noSerialB);
	expect(enabled(noSerialB)).toEqual([false]);
	await toggle(noSerialB, true);
	await plug(placeholderB);
	expect(enabled(placeholderB)).toEqual([false]);
});

test("S11: a moved twin stays out until enabled at the new port", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(movedA);
	expect(enabled(movedA)).toEqual([false]);
	await toggle(movedA, true);
	await reload();
	await plug(movedA);
	expect(enabled(movedA)).toEqual([true]);
});

test("S10 / D2a: enabling a pending twin does not authorize the as-yet unseen group", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();
	attach([twinA, twinB], B.ifname);
	await toggle(twinB, true, false);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});

test("S12: a serial-less device of the pinned product stays out until explicitly enabled", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	await reload();
	await plug(noSerialB);
	expect(enabled(noSerialB)).toEqual([false]);
	await toggle(noSerialB, true);
	expect(enabled(noSerialB)).toEqual([true]);
});

test("R1: a different USB product keeps its uplink after Ethernet is disabled at a scan-pinned port", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	await plug();

	const replacement = { ...noSerialB, idProduct: "9091" };
	const publications = await plug(replacement);
	const { anchor, legacyLinkId, pid } = resolveModemPhysicalIdentity(B.ifname);
	expect([anchor, legacyLinkId, pid]).toEqual(["id-path", undefined, "9091"]);
	attach([replacement], undefined, [ETH]);
	await toggle(ETH, false);
	expect({ publications, afterEthernetOff: enabled(replacement, ETH) }).toEqual(
		{
			publications: [[true]],
			afterEthernetOff: [true, false],
		},
	);
});

test("a dormant scan pin survives a different product and restart but does not override a port disable", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	const replacement = { ...noSerialB, idProduct: "9091" };
	expect(await plug(replacement)).toEqual([[true]]);
	await toggle(replacement, true);
	await reload();
	expect(await plug(twinA, noSerialB)).toEqual([[true, false]]);
	await toggle(noSerialB, false);
	await reload();
	expect(await plug(replacement)).toEqual([[false]]);
});

test("R2: blocked scan pins persist once storage recovers and survive restart without a serial", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();

	const before = readFileSync(configPath, "utf8");
	chmodSync(dir, 0o500);
	try {
		expect(await plug(twinA, twinB)).toEqual([[true, false]]);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	} finally {
		chmodSync(dir, 0o700);
	}

	// Recovery must not depend on getting a new pin to write.
	await plug(twinA);
	await plug(twinA, twinB);
	const recoveredInode = statSync(configPath).ino;
	await plug(twinA, twinB);
	expect(statSync(configPath).ino).toBe(recoveredInode);
	await reload();
	await plug(twinA, noSerialB);
	expect(resolveModemPhysicalIdentity(B.ifname).legacyLinkId).toBeUndefined();
	expect({
		saved: readFileSync(configPath, "utf8") !== before,
		published: enabled(twinA, noSerialB),
	}).toEqual({ saved: true, published: [true, false] });
});

test("#688 H1: an unrelated group enable cannot lift an exact exclusion on same-port serial loss", async () => {
	await seed([G, P]);
	await plug(twinA, twinB);
	await plug(placeholderB);
	await toggle(placeholderB, true);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([false, false]);
	await toggle(twinA, true);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
	const portId = resolveModemPhysicalIdentity(B.ifname).linkId;
	await reload();
	await plug(twinA, noSerialB);
	const identity = resolveModemPhysicalIdentity(B.ifname);
	expect(identity.linkId).toBe(portId);
	expect(identity.legacyLinkId).toBeUndefined();
	expect(enabled(twinA, noSerialB)).toEqual([true, false]);
});

test("#688 H2: a pending singleton OFF then ON takes effect once its identity settles", async () => {
	attach([singletonA], A.ifname);
	await toggle(singletonA, false);
	await toggle(singletonA, true, false);
	await plug(singletonA);
	expect(enabled(singletonA)).toEqual([true]);
});

test("#688 H3: an eth0 enable during the shared-LAN transition takes effect back in uplink", async () => {
	attach([]);
	await toggle(ETH, false);
	persistEthernetRole(ETH.ifname, "shared-lan");
	await toggle(ETH, true, false);
	attach([]);
	expect(enabled(ETH)).toEqual([false]);
	persistEthernetRole(ETH.ifname, "uplink");
	attach([]);
	expect(enabled(ETH)).toEqual([true]);
});

async function evictKnownGroup() {
	for (let i = 0; i < 64; i++) {
		const serial = `ConstructedNewPair${i}`;
		await plug({ ...A, serial }, { ...B, serial });
	}
	await reload();
}

test("#688 H4 / S8: after eviction, a lone-serial disable then enable retains main's result", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await evictKnownGroup();
	await plug(twinA);
	expect(resolveModemPhysicalIdentity(A.ifname).linkId).toBe(G);
	await toggle(twinA, false);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, true]);
});

test("S9: an evicted sibling alone matches main, but is excluded again when the pair is relearned", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await evictKnownGroup();
	await plug(twinB);
	expect(resolveModemPhysicalIdentity(B.ifname).linkId).toBe(G);
	expect(enabled(twinB)).toEqual([true]);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});
