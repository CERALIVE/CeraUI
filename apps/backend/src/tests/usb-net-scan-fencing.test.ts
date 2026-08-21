/*
 * Overlapping USB-net sweeps may not commit out of order.
 *
 * The ordering here is CONTROLLED, never timed: the older sweep is held at its
 * first sysfs read by a manually-resolved promise, and the newer sweep is
 * awaited to completion before that gate is opened. So "the older result lands
 * last" is a fact of the test's own control flow rather than of a `sleep` that
 * a slow machine could invert.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
	getRouterCellularMarker,
	getUsbPhysicalDescriptor,
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	scanUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import type { UsbNetDevice } from "../modules/network/usb-net-classifier.ts";

/** Huawei HiLink `12d1:14dc` — ECM tether plus the ZeroCD storage companion. */
const HUAWEI_HILINK: UsbNetDevice = {
	vendorId: "12d1",
	productId: "14dc",
	bDeviceClass: 0x02,
	manufacturer: "HUAWEI_MOBILE",
	product: "HUAWEI_MOBILE",
	interfaces: [
		{
			interfaceClass: 0x02,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x00,
			driver: "cdc_ether",
		},
		{
			interfaceClass: 0x0a,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x00,
			driver: "cdc_ether",
		},
		{
			interfaceClass: 0x08,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x50,
			driver: "usb-storage",
		},
	],
};

/** ZTE MF79U-class `19d2:1405` — the same shape under a different SKU. */
const ZTE_MF79U: UsbNetDevice = {
	vendorId: "19d2",
	productId: "1405",
	bDeviceClass: 0x00,
	manufacturer: "ZTE,Incorporated",
	product: "ZTE Mobile Boardband",
	interfaces: [
		{
			interfaceClass: 0x02,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x00,
			driver: "cdc_ether",
		},
		{
			interfaceClass: 0x0a,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "cdc_ether",
		},
		{
			interfaceClass: 0x08,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x50,
			driver: "usb-storage",
		},
	],
};

type Gate = { readonly passed: Promise<void>; open(): void };

function makeGate(): Gate {
	let release: () => void = () => undefined;
	const passed = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { passed, open: release };
}

type FixtureTree = Record<string, { device: UsbNetDevice; busId: string }>;

type Fixture = {
	readonly deps: RouterCellularScanDeps;
	/** One per interface examined, so it counts whole sweeps for a 1-if tree. */
	reads(): number;
};

const hex = (value: number): string => value.toString(16).padStart(2, "0");

function fixture(tree: FixtureTree, gate?: Gate): Fixture {
	const attrs = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	const links = new Map<string, string>();
	const driverLinks = new Map<string, string>();

	for (const [ifname, { device, busId }] of Object.entries(tree)) {
		const devDir = `/sys/devices/usb/${busId}`;
		links.set(`/sys/class/net/${ifname}/device`, `${devDir}/${busId}:1.0`);
		attrs.set(`${devDir}/idVendor`, device.vendorId);
		attrs.set(`${devDir}/idProduct`, device.productId);
		attrs.set(`${devDir}/bDeviceClass`, hex(device.bDeviceClass));
		if (device.manufacturer) {
			attrs.set(`${devDir}/manufacturer`, device.manufacturer);
		}
		if (device.product) attrs.set(`${devDir}/product`, device.product);

		const entries = ["power", "driver"];
		device.interfaces.forEach((iface, index) => {
			const name = `${busId}:1.${index}`;
			entries.push(name);
			attrs.set(`${devDir}/${name}/bInterfaceClass`, hex(iface.interfaceClass));
			attrs.set(
				`${devDir}/${name}/bInterfaceSubClass`,
				hex(iface.interfaceSubClass),
			);
			attrs.set(
				`${devDir}/${name}/bInterfaceProtocol`,
				hex(iface.interfaceProtocol),
			);
			if (iface.driver) {
				driverLinks.set(
					`${devDir}/${name}/driver`,
					`/sys/bus/usb/drivers/${iface.driver}`,
				);
			}
		});
		dirs.set(devDir, entries);
	}

	let reads = 0;
	return {
		reads: () => reads,
		deps: {
			sysfsRoot: "/",
			udevDataRoot: "/run/udev/data",
			listDir: async (path) => dirs.get(path) ?? [],
			readAttr: async (path) => attrs.get(path),
			resolveLink: async (path) => {
				reads += 1;
				// The netdev link is the FIRST read of a device, so holding it
				// here parks the whole sweep before it can commit anything.
				if (gate) await gate.passed;
				return links.get(path);
			},
			readLinkName: async (path) => driverLinks.get(path)?.split("/").pop(),
		},
	};
}

describe("refreshUsbNetMarkers — generation-fenced single flight", () => {
	beforeEach(() => {
		resetUsbNetMarkers();
	});

	it("drops an OLDER sweep that completes after a NEWER one", async () => {
		const gate = makeGate();
		const older = fixture(
			{ eth1: { device: HUAWEI_HILINK, busId: "1-1.1" } },
			gate,
		);
		const newer = fixture({ eth1: { device: ZTE_MF79U, busId: "1-1.2" } });

		const settled: string[] = [];
		const olderRun = refreshUsbNetMarkers(["eth1"], older.deps).then(
			(changed) => {
				settled.push("older");
				return changed;
			},
		);
		const newerRun = refreshUsbNetMarkers(["eth1"], newer.deps).then(
			(changed) => {
				settled.push("newer");
				return changed;
			},
		);

		expect(await newerRun).toBe(true);
		expect(getRouterCellularMarker("eth1")?.vid_pid).toBe("19d2:1405");

		gate.open();
		expect(await olderRun).toBe(false);

		expect(settled).toEqual(["newer", "older"]);
		expect(getRouterCellularMarker("eth1")?.vid_pid).toBe("19d2:1405");
		expect(getUsbPhysicalDescriptor("eth1")?.vid).toBe("19d2");

		// Non-vacuity: the older tree really does describe a DIFFERENT device, so
		// a last-writer-wins commit would have left `12d1:14dc` on the wire.
		const olderView = await scanUsbNetMarkers(["eth1"], older.deps);
		expect(olderView.routerCellular.get("eth1")?.vid_pid).toBe("12d1:14dc");
	});

	it("fences the older sweep under natural completion order too", async () => {
		const both = fixture({
			eth1: { device: HUAWEI_HILINK, busId: "1-1.1" },
			eth2: { device: ZTE_MF79U, busId: "1-1.2" },
		});

		const first = refreshUsbNetMarkers(["eth1"], both.deps);
		const second = refreshUsbNetMarkers(["eth1", "eth2"], both.deps);

		expect(await first).toBe(false);
		expect(await second).toBe(true);
		expect(getRouterCellularMarker("eth1")).toBeDefined();
		expect(getRouterCellularMarker("eth2")).toBeDefined();
	});

	it("joins an identical in-flight sweep instead of reading twice", async () => {
		const gate = makeGate();
		const only = fixture(
			{ eth1: { device: HUAWEI_HILINK, busId: "1-1.1" } },
			gate,
		);

		const a = refreshUsbNetMarkers(["eth1"], only.deps);
		const b = refreshUsbNetMarkers(["eth1"], only.deps);
		expect(b).toBe(a);

		gate.open();
		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(only.reads()).toBe(1);
		expect(getRouterCellularMarker("eth1")?.vid_pid).toBe("12d1:14dc");
	});

	it("does not coalesce two different interface sets", async () => {
		const both = fixture({
			eth1: { device: HUAWEI_HILINK, busId: "1-1.1" },
			eth2: { device: ZTE_MF79U, busId: "1-1.2" },
		});

		await Promise.all([
			refreshUsbNetMarkers(["eth1"], both.deps),
			refreshUsbNetMarkers(["eth1", "eth2"], both.deps),
		]);

		expect(both.reads()).toBe(3);
	});

	it("lets a reset fence a sweep that is still reading", async () => {
		const gate = makeGate();
		const only = fixture(
			{ eth1: { device: HUAWEI_HILINK, busId: "1-1.1" } },
			gate,
		);

		const run = refreshUsbNetMarkers(["eth1"], only.deps);
		resetUsbNetMarkers();
		gate.open();

		expect(await run).toBe(false);
		expect(getRouterCellularMarker("eth1")).toBeUndefined();
	});

	it("still commits, and still reports the edge, when sweeps do not overlap", async () => {
		const huawei = fixture({ eth1: { device: HUAWEI_HILINK, busId: "1-1.1" } });
		const zte = fixture({ eth1: { device: ZTE_MF79U, busId: "1-1.2" } });

		expect(await refreshUsbNetMarkers(["eth1"], huawei.deps)).toBe(true);
		expect(getRouterCellularMarker("eth1")?.vid_pid).toBe("12d1:14dc");

		expect(await refreshUsbNetMarkers(["eth1"], zte.deps)).toBe(true);
		expect(getRouterCellularMarker("eth1")?.vid_pid).toBe("19d2:1405");

		expect(await refreshUsbNetMarkers(["eth1"], zte.deps)).toBe(false);
		expect(getRouterCellularMarker("eth1")?.vid_pid).toBe("19d2:1405");
	});
});
