import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import { getConfig, setConfigFilePath } from "../modules/config.ts";
import { modemCredentialKey } from "../modules/modems/modem-credentials.ts";
import {
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
} from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { bondPhysicalId } from "../modules/network/bond-preference.ts";
import {
	handleNetifMonitorEvent,
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import { setup } from "../modules/setup.ts";
import { resetBindMapWriter } from "../modules/streaming/bind-map-writer.ts";
import {
	identityForIface,
	resetBondIdentities,
} from "../modules/streaming/link-registry.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import * as wire from "../modules/ui/websocket-server.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	firstSightIfconfig,
	firstSightPhysicalDevice,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

let directory = "";
let savedIps: typeof setup.ips_file;
let savedMap: typeof setup.bind_map_file;
let scan: ReturnType<typeof firstSightScan>;
let publication: ReturnType<typeof updateNetif>;
let unhandled: unknown[] = [];
const recordUnhandled = (error: unknown) => {
	unhandled.push(error);
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const output = firstSightIfconfig(MODEM, IP);
const addressless = (text: string) => text.replace(/ {8}inet .*?\n/g, "");
const local = () => srtla.genSrtlaBondEntriesForLocalIpAddress("100.64.1.1");

beforeEach(async () => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBindMapWriter();
	resetBondIdentities();
	resetPhysicalIdentityRegistry();
	getConfig().usb_serial_shared = [];
	jest.useFakeTimers();
	directory = await mkdtemp(join(tmpdir(), "bond-readiness-"));
	setConfigFilePath(join(directory, "config.json"));
	savedIps = setup.ips_file;
	savedMap = setup.bind_map_file;
	setup.ips_file = join(directory, "ips");
	setup.bind_map_file = join(directory, "map.json");
	publication = undefined;
	unhandled = [];
	process.on("unhandledRejection", recordUnhandled);
});

afterEach(async () => {
	scan?.release();
	await publication;
	await scan?.settle();
	await tick();
	process.off("unhandledRejection", recordUnhandled);
	expect(unhandled).toEqual([]);
	stopWifiUpdateLoopForTest();
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBindMapWriter();
	resetBondIdentities();
	resetPhysicalIdentityRegistry();
	srtla.resetPublishedBond();
	setConfigFilePath("config.json");
	setup.ips_file = savedIps;
	setup.bind_map_file = savedMap;
	await rm(directory, { recursive: true, force: true });
});

async function publishAtBound(name = MODEM) {
	publication = updateNetif();
	await scan.enteredFor(name);
	await tick();
	jest.advanceTimersByTime(2_000);
	await publication;
}

function expectHeld(name = MODEM) {
	expect(netIfBuildMsg()[name]?.enabled).toBe(false);
	expect(srtla.genSrtlaBondEntries().filter((e) => e.iface === name)).toEqual(
		[],
	);
	expect(local().filter((e) => e.iface === name)).toEqual([]);
}

for (const name of [MODEM, "eth1", "wlan1"]) {
	for (const optedOut of [false, true]) {
		test(`B5 USB ${name} first admission uses physical identity, opt-out=${optedOut}`, async () => {
			const expected = firstSightPhysicalDevice();
			if (expected.idPath === undefined)
				throw new Error("constructed device missing port");
			if (optedOut) getConfig().bond_opt_out = { [expected.linkId]: true };
			scan = firstSightScan(firstSightIfconfig(name, IP), {
				blocked: [name],
				buses: { [name]: "usb" },
				devices: constructedTwins.map((d) => ({
					...d,
					ifname: d.ifname === MODEM ? name : d.ifname,
				})),
			});
			await publishAtBound(name);
			expectHeld(name);
			await srtla.publishSrtlaBond(srtla.genSrtlaBondEntries());
			expect(identityForIface(name)).toBeUndefined();
			expect(await Bun.file(setup.bind_map_file ?? "").json()).toMatchObject({
				links: [],
			});
			scan.release();
			await scan.settle();
			expect(netIfBuildMsg()[name]?.enabled).toBe(!optedOut);
			expect(local()).toEqual([
				{
					iface: name,
					ip: IP,
					linkId: expected.linkId,
					idPath: expected.idPath,
				},
			]);
			await srtla.publishSrtlaBond(srtla.genSrtlaBondEntries());
			if (optedOut) expect(identityForIface(name)).toBeUndefined();
			else {
				expect(identityForIface(name)?.linkId).toBe(expected.linkId);
				expect(await Bun.file(setup.bind_map_file ?? "").json()).toMatchObject({
					links: [{ iface: name, ip: IP, link_id: expected.linkId }],
				});
			}
		});
	}
}

test("B6 pending bus at first addressed offer stays held until coverage", async () => {
	scan = firstSightScan(output);
	const bus = Promise.withResolvers<string | undefined>();
	scan.setBus(MODEM, () => bus.promise);
	try {
		await publishAtBound();
		expectHeld();
		bus.resolve("usb");
		await tick();
		await publishAtBound();
		expectHeld();
		scan.release();
		await scan.settle();
		expect(local()[0]?.linkId).toBe(firstSightPhysicalDevice().linkId);
	} finally {
		bus.resolve(undefined);
	}
});

test("B6 addressless unsettled names retry classification and latch positive USB", async () => {
	scan = firstSightScan(addressless(output));
	await publishAtBound();
	const readsBefore = scan.busCounts.get(MODEM) ?? 0;
	scan.setBus(MODEM, async () => "usb");
	scan.setOutput(output);
	await publishAtBound();
	expectHeld();
	expect(scan.busCounts.get(MODEM)).toBe(readsBefore + 1);
	scan.setBus(MODEM, async () => undefined);
	await publishAtBound();
	expectHeld();
	expect(scan.busCounts.get(MODEM)).toBe(readsBefore + 1);
});

test("B6 rejecting bus reads stay held with one debug record", async () => {
	scan = firstSightScan(output);
	scan.setBus(MODEM, async () => {
		throw new Error("constructed bus rejection");
	});
	const debug = spyOn(logger, "debug");
	await publishAtBound();
	await tick();
	expectHeld();
	expect(
		debug.mock.calls.filter((args) => {
			const message: unknown = args[0];
			return message === "netdev bus read failed";
		}),
	).toHaveLength(1);
	expect(unhandled).toEqual([]);
});

test("B7 shared-serial twins first join with distinct port identities", async () => {
	const devices = constructedTwins.map((d) => ({
		...d,
		serial: "constructed-shared-unit",
	}));
	const names = devices.map((d) => d.ifname);
	scan = firstSightScan(
		names.map((name) => firstSightIfconfig(name, IP)).join("\n\n"),
		{
			devices,
			blocked: names,
			buses: Object.fromEntries(names.map((name) => [name, "usb"])),
		},
	);
	await publishAtBound(names[0]);
	for (const name of names) expectHeld(name);
	scan.release();
	await scan.settle();
	const expected = devices.map((d) => ({
		iface: d.ifname,
		ip: IP,
		idPath: d.udevadm.ID_PATH,
		linkId: resolvePhysicalDevice({
			ifname: d.ifname,
			idPath: d.udevadm.ID_PATH,
			vid: d.idVendor,
			pid: d.idProduct,
		}).linkId,
	}));
	expect(srtla.genSrtlaBondEntries()).toEqual(expected);
	expect(new Set(expected.map((e) => e.linkId)).size).toBe(2);
	expect(getConfig().usb_serial_shared).toHaveLength(1);
	await srtla.publishSrtlaBond(srtla.genSrtlaBondEntries());
	for (const entry of expected)
		expect(identityForIface(entry.iface)?.linkId).toBe(entry.linkId);
});

for (const release of ["deadline", "coverage"] as const) {
	test(`B8/B9 ${release} release reaches broadcastMsg without another state change`, async () => {
		scan = firstSightScan(output, { buses: { [MODEM]: "usb" } });
		await publishAtBound();
		expectHeld();
		const frames: unknown[] = [];
		spyOn(wire, "broadcastMsg").mockImplementation((type, payload) => {
			if (type === "netif") frames.push(structuredClone(payload));
		});
		let changes = 0;
		const off = onNetworkInterfacesChange(() => {
			changes++;
		});
		const warn = spyOn(logger, "warn");
		try {
			if (release === "coverage") {
				scan.release();
				await scan.settle();
			} else {
				scan.clock.now = 14_999;
				processIfconfigOutput(output);
				expectHeld();
				scan.clock.now = 15_000;
				processIfconfigOutput(output);
				processIfconfigOutput(output);
				expect(
					warn.mock.calls.filter((args) => {
						const message: unknown = args[0];
						return (
							message ===
							"USB identity deadline expired; using fallback identity"
						);
					}),
				).toHaveLength(1);
			}
			expect(changes).toBe(1);
			expect(
				frames.some(
					(frame) =>
						typeof frame === "object" &&
						frame !== null &&
						Reflect.get(frame, MODEM)?.enabled === true,
				),
			).toBe(true);
			expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
			if (release === "coverage") {
				await refreshUsbNetMarkers([]);
				expect(usbNetScanCovers(MODEM)).toBe(false);
				expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
				expect(local()).toHaveLength(1);
			}
		} finally {
			off();
		}
	});
}

test("B10 a rejected descriptor read releases weakly at covering commit", async () => {
	scan = firstSightScan(
		`${output}\n\n${firstSightIfconfig("eth9", "192.0.2.2")}`,
		{
			buses: { [MODEM]: "usb", eth9: "platform" },
		},
	);
	const deps = constructedTwinDeps();
	spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
		async (path) => {
			if (path.endsWith("/idVendor"))
				throw new Error("constructed descriptor rejection");
			return deps.readAttr(path);
		},
	);
	await publishAtBound();
	expectHeld();
	scan.release();
	await scan.settle();
	expect(usbNetScanCovers(MODEM)).toBe(true);
	expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
	expect(
		srtla.genSrtlaBondEntries().filter((entry) => entry.iface === MODEM),
	).toEqual([
		{
			iface: MODEM,
			ip: IP,
			linkId: resolvePhysicalDevice({ ifname: MODEM }).linkId,
		},
	]);
	expect(bondPhysicalId(MODEM)).toBeUndefined();
	expect(
		modemCredentialKey(resolveModemPhysicalIdentity(MODEM)),
	).toBeUndefined();
	expect(netIfBuildMsg().eth9?.enabled).toBe(true);
	expect(
		srtla.genSrtlaBondEntries().filter((entry) => entry.iface === "eth9"),
	).toEqual([
		{ iface: "eth9", ip: "192.0.2.2", linkId: "lnk_7b0bd35950ec673f" },
	]);
	expect(srtla.genSrtlaBondEntriesForLocalIpAddress("192.0.2.1")).toEqual([
		{ iface: "eth9", ip: "192.0.2.2", linkId: "lnk_7b0bd35950ec673f" },
	]);
});

for (const removal of ["monitor", "absent", "not-running"] as const) {
	test(`B12 observed ${removal} drops admission for a returning incarnation`, async () => {
		scan = firstSightScan(output, { blocked: [], buses: { [MODEM]: "usb" } });
		await scan.settle();
		await updateNetif();
		if (removal === "monitor")
			handleNetifMonitorEvent({
				type: "device-state",
				device: MODEM,
				state: "disconnected",
			});
		else
			processIfconfigOutput(
				removal === "absent" ? "" : output.replace(",RUNNING", ""),
			);
		await refreshUsbNetMarkers([]);
		scan.block(MODEM);
		await publishAtBound();
		expectHeld();
	});
}

for (const variant of [
	"replace",
	"control",
	"create",
	"create-delete",
] as const) {
	test(`B14 parked bus result respects observed presence: ${variant}`, async () => {
		const ethernet = firstSightIfconfig("eth9", "192.0.2.2");
		scan = firstSightScan(ethernet, { blocked: ["eth9"] });
		if (variant === "replace" || variant === "control")
			processIfconfigOutput(addressless(ethernet));
		const bus = Promise.withResolvers<string | undefined>();
		scan.setBus("eth9", () => bus.promise);
		publication = updateNetif();
		try {
			await scan.enteredFor("eth9");
			if (variant === "replace")
				handleNetifMonitorEvent({
					type: "device-state",
					device: "eth9",
					state: "disconnected",
				});
			if (variant !== "control")
				handleNetifMonitorEvent({
					type: "device-state",
					device: "eth9",
					state: "connected",
				});
			if (variant === "create-delete")
				handleNetifMonitorEvent({
					type: "device-state",
					device: "eth9",
					state: "disconnected",
				});
			scan.setBus("eth9", async () => "pci");
			bus.resolve("usb");
			await tick();
			jest.advanceTimersByTime(2_000);
			await publication;
			const reads = scan.busCounts.get("eth9");
			for (let refresh = 0; refresh < 2; refresh++) {
				expect(netIfBuildMsg().eth9?.enabled).toBe(variant !== "control");
				const expected =
					variant === "control"
						? []
						: [
								{
									iface: "eth9",
									ip: "192.0.2.2",
									linkId: "lnk_7b0bd35950ec673f",
								},
							];
				expect(srtla.genSrtlaBondEntries()).toEqual(expected);
				expect(srtla.genSrtlaBondEntriesForLocalIpAddress("192.0.2.1")).toEqual(
					expected,
				);
				await publishAtBound("eth9");
			}
			expect(scan.busCounts.get("eth9")).toBe(reads);
		} finally {
			bus.resolve(undefined);
		}
	});
}

for (const [releaseAt, early] of [
	[1_999, false],
	[2_000, true],
	[2_000, false],
	[2_001, false],
] as const) {
	for (const ethBlocked of [false, true]) {
		test(`B11 USB has no provisional bond identity at ${releaseAt}, early=${early}, Ethernet pending=${ethBlocked}`, async () => {
			scan = firstSightScan(
				`${output}\n\n${firstSightIfconfig("eth9", "192.0.2.2")}`,
				{
					blocked: ethBlocked ? [MODEM, "eth9"] : [MODEM],
					buses: { [MODEM]: "usb", eth9: "platform" },
				},
			);
			if (early) setTimeout(scan.release, releaseAt);
			publication = updateNetif();
			await scan.entered;
			if (!early) setTimeout(scan.release, releaseAt);
			jest.advanceTimersByTime(2_000);
			await publication;
			const weak = resolvePhysicalDevice({ ifname: MODEM }).linkId;
			expect(srtla.genSrtlaBondEntries().some((e) => e.linkId === weak)).toBe(
				false,
			);
			expect(local().some((e) => e.linkId === weak)).toBe(false);
			scan.release();
			await scan.settle();
			expect(
				srtla.genSrtlaBondEntries().find((e) => e.iface === MODEM)?.linkId,
			).toBe(firstSightPhysicalDevice().linkId);
		});
	}
}
