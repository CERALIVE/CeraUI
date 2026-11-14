import { afterEach, expect, jest, test } from "bun:test";
import { resolvePhysicalDevice } from "../modules/modems/physical-identity.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import {
	firstSightIfconfig,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
});

test.each(["eth9", "wlan0"])(
	"%s retains main's bond admission while an earlier modem scan stalls",
	async (ifname) => {
		jest.useFakeTimers();
		resetUsbNetMarkers();
		resetNetifSnapshotForTest();
		resetBondOptOut();
		const address = "192.0.2.2";
		const expected = {
			ip: address,
			iface: ifname,
			linkId: resolvePhysicalDevice({ ifname }).linkId,
		};
		const scan = firstSightScan(
			[firstSightIfconfig(MODEM, IP), firstSightIfconfig(ifname, address)].join(
				"\n\n",
			),
			ifname === "wlan0" ? [MODEM, ifname] : [MODEM],
		);
		const publication = updateNetif();
		try {
			await scan.entered;
			jest.advanceTimersByTime(2_000);
			await publication;
			expect(getNetworkInterfaces()[ifname]?.ip).toBe(address);
			expect(usbNetScanCovers(ifname)).toBe(false);
			expect(netIfBuildMsg()[ifname]?.enabled).toBe(true);
			expect(genSrtlaBondEntries()).toEqual([expected]);
			expect(genSrtlaBondEntriesForLocalIpAddress("192.0.2.9")).toEqual([
				expected,
			]);
		} finally {
			scan.release();
			await publication;
			await scan.settle();
		}
	},
);

test("a covered USB modem retains its physical identity while another modem scan stalls", async () => {
	jest.useFakeTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
	const covered = constructedTwins.find((device) => device.ifname !== MODEM);
	if (covered === undefined)
		throw new Error("missing constructed covered modem");
	await refreshUsbNetMarkers([covered.ifname], constructedTwinDeps());
	const expected = {
		ip: "100.64.1.3",
		iface: covered.ifname,
		linkId: resolvePhysicalDevice({
			ifname: covered.ifname,
			idPath: covered.udevadm.ID_PATH,
			vid: covered.idVendor,
			pid: covered.idProduct,
		}).linkId,
		idPath: covered.udevadm.ID_PATH,
	};
	const scan = firstSightScan(
		[
			firstSightIfconfig(MODEM, IP),
			firstSightIfconfig(covered.ifname, expected.ip),
		].join("\n\n"),
	);
	const publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		expect(usbNetScanCovers(covered.ifname)).toBe(true);
		expect(netIfBuildMsg()[covered.ifname]?.enabled).toBe(true);
		expect(genSrtlaBondEntries()).toEqual([expected]);
		expect(genSrtlaBondEntriesForLocalIpAddress("100.64.1.9")).toEqual([
			expected,
		]);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
	}
});

test("an Ethernet-named USB interface still waits for the cohort identity commit", async () => {
	jest.useFakeTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
	const devices = constructedTwins.map((device) =>
		device.ifname === MODEM ? device : { ...device, ifname: "eth9" },
	);
	const scan = firstSightScan(
		[
			firstSightIfconfig(MODEM, IP),
			firstSightIfconfig("eth9", "192.0.2.2"),
		].join("\n\n"),
		[MODEM],
		devices,
	);
	const publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		expect(netIfBuildMsg().eth9?.enabled).toBe(false);
		expect(genSrtlaBondEntries()).toEqual([]);
		expect(genSrtlaBondEntriesForLocalIpAddress("192.0.2.9")).toEqual([]);
		scan.release();
		await scan.settle();
		expect(netIfBuildMsg().eth9?.enabled).toBe(true);
		expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual([
			MODEM,
			"eth9",
		]);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
	}
});

test("a superseded non-USB read cannot exempt a pending USB interface", async () => {
	jest.useFakeTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
	const olderRead = Promise.withResolvers<string | undefined>();
	const older = refreshUsbNetMarkers([MODEM], {
		...constructedTwinDeps(),
		resolveLink: () => olderRead.promise,
	});
	const scan = firstSightScan(firstSightIfconfig(MODEM, IP));
	const publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		olderRead.resolve(undefined);
		await older;
		expect(usbNetScanCovers(MODEM)).toBe(false);
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(false);
		expect(genSrtlaBondEntries()).toEqual([]);
	} finally {
		olderRead.resolve(undefined);
		scan.release();
		await older;
		await publication;
		await scan.settle();
	}
});
