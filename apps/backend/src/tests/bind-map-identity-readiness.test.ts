import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import { resetUsbNetMarkers } from "../modules/network/router-cellular-scan.ts";
import { describeBondEntry } from "../modules/streaming/bond-entry.ts";
import {
	identityForIface,
	registerBondIdentities,
	resetBondIdentities,
} from "../modules/streaming/link-registry.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import {
	firstSightIfconfig,
	firstSightPhysicalDevice,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondIdentities();
});

test("(e) an uncovered publication has no bond admission or link id until coverage", async () => {
	jest.useFakeTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	const scan = firstSightScan(firstSightIfconfig(MODEM, IP));
	const publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		expect(getNetworkInterfaces()[MODEM]).toBeDefined();
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(false);
		expect(genSrtlaBondEntries()).toEqual([]);
		expect(genSrtlaBondEntriesForLocalIpAddress("100.64.1.9")).toEqual([]);
		const pending = describeBondEntry(MODEM, IP);
		expect(pending.linkId).toBeUndefined();
		registerBondIdentities([pending]);
		expect(identityForIface(MODEM)?.linkId).toBeUndefined();
		scan.release();
		await scan.settle();
		expect(genSrtlaBondEntries()[0]?.linkId).toBe(
			firstSightPhysicalDevice().linkId,
		);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
	}
});

test("(e) the shared fifteen-second deadline admits fallback and warns once per name", async () => {
	jest.useFakeTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	const scan = firstSightScan(firstSightIfconfig(MODEM, IP));
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	const observed: boolean[] = [];
	const unsubscribe = onNetworkInterfacesChange(() => {
		observed.push(netIfBuildMsg()[MODEM]?.enabled ?? false);
	});
	const publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		scan.clock.now = 14_999;
		expect(genSrtlaBondEntries()).toEqual([]);
		scan.clock.now = 15_000;
		processIfconfigOutput(firstSightIfconfig(MODEM, IP));
		const entries = genSrtlaBondEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.linkId).toBeDefined();
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
		expect(genSrtlaBondEntries()).toEqual(entries);
		expect(observed).toEqual([false, true]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"USB identity deadline expired; using fallback identity",
			{ ifname: MODEM },
		);
	} finally {
		unsubscribe();
		scan.release();
		await publication;
		await scan.settle();
	}
});
