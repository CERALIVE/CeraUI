import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	handleNetifMonitorEvent,
	netIfBuildMsg,
	processIfconfigOutput,
	refreshRouterCellularState,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
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
import {
	firstSightIfconfig,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";

const ethernet = firstSightIfconfig("eth9", "192.0.2.2");
const output = `${firstSightIfconfig(MODEM, IP)}\n\n${ethernet}`;
const expectedEntries = [
	{ ip: "192.0.2.2", iface: "eth9", linkId: "lnk_7b0bd35950ec673f" },
];
let directory = "";
let savedIps: typeof setup.ips_file;
let savedMap: typeof setup.bind_map_file;

beforeEach(async () => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBindMapWriter();
	resetBondIdentities();
	jest.useFakeTimers();
	directory = await mkdtemp(join(tmpdir(), "bond-parity-"));
	savedIps = setup.ips_file;
	savedMap = setup.bind_map_file;
	setup.ips_file = join(directory, "ips");
	setup.bind_map_file = join(directory, "map.json");
});

afterEach(async () => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBindMapWriter();
	resetBondIdentities();
	srtla.resetPublishedBond();
	setup.ips_file = savedIps;
	setup.bind_map_file = savedMap;
	await rm(directory, { recursive: true, force: true });
});

async function expectEthernetParity() {
	expect(netIfBuildMsg().eth9).toEqual({
		ip: "192.0.2.2",
		tp: 0,
		enabled: true,
		tx_bps: 0,
		rx_bps: 0,
		ethRole: "uplink",
		ethRoleOp: true,
	});
	expect(srtla.genSrtlaBondEntries().filter((e) => e.iface === "eth9")).toEqual(
		expectedEntries,
	);
	expect(
		srtla
			.genSrtlaBondEntriesForLocalIpAddress("192.0.2.1")
			.filter((e) => e.iface === "eth9"),
	).toEqual(expectedEntries);
	await srtla.publishSrtlaBond(srtla.genSrtlaBondEntries());
	expect(identityForIface("eth9")).toEqual({
		identityState: "resolved",
		linkId: "lnk_7b0bd35950ec673f",
		iface: "eth9",
		ip: "192.0.2.2",
	});
	const document: unknown = await Bun.file(setup.bind_map_file ?? "").json();
	if (typeof document !== "object" || document === null)
		throw new Error("missing sidecar");
	const links: unknown = Reflect.get(document, "links");
	if (!Array.isArray(links)) throw new Error("missing sidecar links");
	expect(
		links.filter(
			(row: unknown) =>
				typeof row === "object" &&
				row !== null &&
				Reflect.get(row, "iface") === "eth9",
		),
	).toEqual([
		{ link_id: "lnk_7b0bd35950ec673f", iface: "eth9", ip: "192.0.2.2" },
	]);
}

for (const state of [
	"stalled",
	"rejected",
	"slow-complete",
	"covered",
	"both-pending",
] as const) {
	test(`B1/B2 Ethernet parity: ${state}`, async () => {
		const scan = firstSightScan(output, {
			blocked:
				state === "covered" || state === "rejected"
					? []
					: state === "both-pending"
						? [MODEM, "eth9"]
						: [MODEM],
			buses: { [MODEM]: "usb", eth9: "platform" },
		});
		if (state === "covered") await scan.settle();
		if (state === "rejected")
			spyOn(defaultRouterCellularScanDeps, "resolveLink").mockRejectedValueOnce(
				new Error("constructed vanished link"),
			);
		const publication = updateNetif();
		try {
			if (state !== "covered" && state !== "rejected") {
				await scan.entered;
				if (state === "slow-complete") scan.release();
				jest.advanceTimersByTime(2_000);
			}
			await publication;
			for (const now of state === "stalled"
				? [2_000, 5_000, 10_000, 14_999, 15_000, 20_000]
				: [2_000]) {
				scan.clock.now = now;
				if (now !== 2_000) processIfconfigOutput(output);
				await expectEthernetParity();
			}
		} finally {
			scan.release();
			await publication;
			await scan.settle();
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
		test(`B11 Ethernet parity at ${releaseAt}, early=${early}, Ethernet pending=${ethBlocked}`, async () => {
			const scan = firstSightScan(output, {
				blocked: ethBlocked ? [MODEM, "eth9"] : [MODEM],
				buses: { [MODEM]: "usb", eth9: "platform" },
			});
			if (early) setTimeout(scan.release, releaseAt);
			const publication = updateNetif();
			try {
				await scan.entered;
				if (!early) setTimeout(scan.release, releaseAt);
				jest.advanceTimersByTime(2_000);
				await publication;
				await expectEthernetParity();
			} finally {
				scan.release();
				await publication;
				await scan.settle();
			}
		});
	}
}

for (const name of ["br-test", "vlan-test", "bond-test"]) {
	test(`B11 virtual ${name} retains its own identity without bus evidence`, async () => {
		const scan = firstSightScan(firstSightIfconfig(name, "192.0.2.2"), {
			blocked: [name],
		});
		const publication = updateNetif();
		try {
			await scan.enteredFor(name);
			jest.advanceTimersByTime(2_000);
			await publication;
			expect(netIfBuildMsg()[name]?.enabled).toBe(true);
			const entries = [{ iface: name, ip: "192.0.2.2" }];
			expect(srtla.genSrtlaBondEntries()).toMatchObject(entries);
			expect(
				srtla.genSrtlaBondEntriesForLocalIpAddress("192.0.2.1"),
			).toMatchObject(entries);
		} finally {
			scan.release();
			await publication;
			await scan.settle();
		}
	});
}

test("B3 a new scan generation never withdraws admitted Ethernet", async () => {
	const scan = firstSightScan(output, {
		buses: { [MODEM]: "usb", eth9: "platform" },
	});
	let publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		await expectEthernetParity();
		scan.block("eth9");
		scan.setOutput(
			`${ethernet}\n\n${firstSightIfconfig(MODEM, IP)}\n\n${firstSightIfconfig("eth10", "198.51.100.2")}`,
		);
		publication = updateNetif();
		await scan.enteredFor("eth9");
		await expectEthernetParity();
		jest.advanceTimersByTime(2_000);
		await publication;
		await expectEthernetParity();
	} finally {
		scan.release();
		await publication;
		await scan.settle();
	}
});

test("B4 a smaller periodic scan cannot re-hold an admitted USB incarnation", async () => {
	const scan = firstSightScan(output, {
		blocked: [],
		buses: { [MODEM]: "usb" },
	});
	await scan.settle();
	await updateNetif();
	handleNetifMonitorEvent({
		type: "device-state",
		device: MODEM,
		state: "disconnected",
	});
	scan.block("eth9");
	const periodic = refreshRouterCellularState();
	try {
		await scan.enteredFor("eth9");
		await updateNetif();
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
		scan.release();
		await periodic;
		expect(usbNetScanCovers(MODEM)).toBe(false);
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
		expect(srtla.genSrtlaBondEntries().some((e) => e.iface === MODEM)).toBe(
			true,
		);
	} finally {
		scan.release();
		await periodic;
		await scan.settle();
	}
});
