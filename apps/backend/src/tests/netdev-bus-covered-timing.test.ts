import { afterEach, expect, jest, spyOn, test } from "bun:test";
import {
	netIfBuildMsg,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import {
	firstSightIfconfig,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";
import { constructedTwinDeps } from "./helpers/constructed-usb-twins.ts";

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
});

test("covered publication does not await a hung classifier and creates no timer or I/O-turn wait", async () => {
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
	jest.useFakeTimers();
	const f = firstSightScan(firstSightIfconfig(MODEM, IP), { blocked: [] });
	await refreshUsbNetMarkers([MODEM], constructedTwinDeps());
	const hung = Promise.withResolvers<string | undefined>();
	f.setBus(MODEM, () => hung.promise);
	const timeout = spyOn(globalThis, "setTimeout");
	const order: string[] = [];
	const nextTurn = new Promise<void>((resolve) =>
		setImmediate(() => {
			order.push("io-turn");
			resolve();
		}),
	);
	try {
		await updateNetif();
		order.push("published");
		await nextTurn;
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(true);
		expect(timeout).toHaveBeenCalledTimes(0);
		expect(order).toEqual(["published", "io-turn"]);
	} finally {
		hung.resolve("usb");
		f.release();
	}
});
