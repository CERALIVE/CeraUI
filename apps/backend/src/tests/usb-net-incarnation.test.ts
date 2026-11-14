import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { dirname } from "node:path";
import {
	handleNetifMonitorEvent,
	processIfconfigOutput,
	resetNetifSnapshotForTest,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	getModemNetMarker,
	getRouterCellularMarker,
	getUsbPhysicalDescriptor,
	onUsbNetScanCommitted,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import { firstSightIfconfig } from "./helpers/bond-first-sight-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const IFACE = "eth9";
const OTHER = "eth10";
const ifnames = [IFACE, OTHER];
const output = firstSightIfconfig(IFACE, "192.0.2.9");
const [first, second] = constructedTwins;
if (!first || !second) throw new Error("missing constructed USB devices");
const oldDevice = { ...first, ifname: IFACE };
const newDevice = { ...second, ifname: IFACE };
const otherDevice = { ...second, ifname: OTHER };

beforeEach(() => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
});

afterEach(() => {
	jest.restoreAllMocks();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
});

function monitor(state: string): void {
	handleNetifMonitorEvent({ type: "device-state", device: IFACE, state });
}

function parkedScan() {
	const oldTree = constructedTwinDeps([oldDevice, otherDevice]);
	const newTree = constructedTwinDeps([newDevice, otherDevice]);
	const entered = Promise.withResolvers<void>();
	const oldGate = Promise.withResolvers<void>();
	const freshGate = Promise.withResolvers<void>();
	let replacement: "none" | "pci" | "usb" = "none";
	let reads = 0;
	spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
		async (path) => {
			if (path !== `/sys/class/net/${IFACE}/device`)
				return oldTree.resolveLink(path);
			reads++;
			if (reads === 1) {
				const captured = await oldTree.resolveLink(path);
				entered.resolve();
				await oldGate.promise;
				return captured;
			}
			await freshGate.promise;
			return replacement === "pci"
				? undefined
				: (replacement === "usb" ? newTree : oldTree).resolveLink(path);
		},
	);
	spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
		async (path) =>
			(await oldTree.readAttr(path)) ?? (await newTree.readAttr(path)),
	);
	spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
		oldTree.listDir,
	);
	spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
		oldTree.readLinkName,
	);
	return {
		entered: entered.promise,
		releaseOld: () => oldGate.resolve(),
		releaseFresh: () => freshGate.resolve(),
		replace: (kind: typeof replacement) => {
			replacement = kind;
		},
		reads: () => reads,
	};
}

for (const publication of ["already present", "first publication"] as const) {
	test(`keeps a covering USB reading without replacement: ${publication}`, async () => {
		if (publication === "already present") processIfconfigOutput(output);
		const scan = parkedScan();
		const pending = refreshUsbNetMarkers(ifnames);
		try {
			await scan.entered;
			if (publication === "first publication") processIfconfigOutput(output);
			scan.releaseOld();
			await pending;
			expect(getUsbPhysicalDescriptor(IFACE)?.usbParent).toBe(
				dirname(oldDevice.readlink),
			);
			expect(usbNetScanCovers(IFACE)).toBe(true);
			expect(scan.reads()).toBe(1);
		} finally {
			scan.releaseOld();
			scan.releaseFresh();
			await pending;
		}
	});
}

for (const observation of [
	"monitor",
	"monitor before publication",
	"poll",
] as const) {
	for (const replacement of ["pci", "usb"] as const) {
		test(`#542 drops an old USB reading after ${observation} replacement by ${replacement}`, async () => {
			if (observation !== "monitor before publication")
				processIfconfigOutput(output);
			const scan = parkedScan();
			const commits: Array<{
				descriptor: ReturnType<typeof getUsbPhysicalDescriptor>;
				covered: boolean;
			}> = [];
			const unsubscribe = onUsbNetScanCommitted(() => {
				commits.push({
					descriptor: getUsbPhysicalDescriptor(IFACE),
					covered: usbNetScanCovers(IFACE),
				});
			});
			const pending = refreshUsbNetMarkers(ifnames);
			try {
				await scan.entered;
				scan.replace(replacement);
				if (observation === "poll") {
					processIfconfigOutput("");
					processIfconfigOutput(output);
				} else {
					monitor("disconnected");
					monitor("connected");
				}
				scan.releaseOld();
				await pending;
				expect(getUsbPhysicalDescriptor(IFACE)).toBeUndefined();
				expect(getModemNetMarker(IFACE)).toBeUndefined();
				expect(getRouterCellularMarker(IFACE)).toBeUndefined();
				expect(usbNetScanCovers(IFACE)).toBe(false);
				expect(getUsbPhysicalDescriptor(OTHER)?.usbParent).toBe(
					dirname(otherDevice.readlink),
				);
				expect(usbNetScanCovers(OTHER)).toBe(true);
				expect(scan.reads()).toBe(2);
				scan.releaseFresh();
				await refreshUsbNetMarkers(ifnames);
				expect(usbNetScanCovers(IFACE)).toBe(true);
				expect(getUsbPhysicalDescriptor(IFACE)?.usbParent).toBe(
					replacement === "usb" ? dirname(newDevice.readlink) : undefined,
				);
				expect(commits.map((commit) => commit.covered)).toEqual([false, true]);
				expect(commits[0]?.descriptor).toBeUndefined();
			} finally {
				scan.releaseOld();
				scan.releaseFresh();
				await pending;
				await refreshUsbNetMarkers(ifnames);
				unsubscribe();
			}
		});
	}
}

test("a USB replacement receives its own descriptor on the next scan", async () => {
	await refreshUsbNetMarkers([IFACE], constructedTwinDeps([oldDevice]));
	processIfconfigOutput(output);
	monitor("disconnected");
	monitor("connected");
	await refreshUsbNetMarkers([IFACE], constructedTwinDeps([newDevice]));
	expect(getUsbPhysicalDescriptor(IFACE)?.usbParent).toBe(
		dirname(newDevice.readlink),
	);
	expect(usbNetScanCovers(IFACE)).toBe(true);
});
