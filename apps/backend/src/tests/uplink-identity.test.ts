/*
 * Uplink identity — the kind comes from the DEVICE, and the name is never made up.
 *
 * The device fixtures below are transcriptions of the CeraLive bench board
 * (`ceralive2`, RK3588, board diagnostics 2026-08-30): `eth1` really is a Huawei
 * E3372 HiLink dongle that lost the udev rename race to its identical twin, and
 * `wwu1u4u4i4` really is the Quectel RM530N-GL's QMI netdev. That board reported
 * the two HiLink twins as `ethernet` and `cellular` respectively while the netif
 * projection classified BOTH correctly — the defect this suite locks shut.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { uplinkHealthRecordSchema } from "@ceraui/rpc/schemas";

import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { UplinkHealthEngine } from "../modules/network/uplink-health/model.ts";
import { resolveUplinkIdentity } from "../modules/network/uplink-identity.ts";
import type { UsbNetDevice } from "../modules/network/usb-net-classifier.ts";

// ── Captured hardware ───────────────────────────────────────────────────────

/** Huawei HiLink `12d1:14dc` — CDC-ECM control + CDC data + ZeroCD storage LUN. */
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

/** Quectel RM530N-GL `2c7c:0801` — a QMI control port makes it MM-managed. */
const QUECTEL_RM530N: UsbNetDevice = {
	vendorId: "2c7c",
	productId: "0801",
	bDeviceClass: 0x00,
	manufacturer: "Quectel",
	product: "RM530N-GL",
	interfaces: [
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0xff,
			interfaceProtocol: 0xff,
			driver: "qmi_wwan",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "option",
		},
	],
};

type FixtureUdev = Record<string, string>;

type FixtureDevice = {
	device: UsbNetDevice;
	busId: string;
	usbfs: { busnum: number; devnum: number };
	udev?: FixtureUdev;
};

/** The bench topology, minus the interfaces that hang off no USB device. */
const BENCH_TREE: Record<string, FixtureDevice> = {
	// The twin that WON the rename race — one factory MAC between the pair.
	enx0c5b8f279a64: {
		device: HUAWEI_HILINK,
		busId: "5-1.3.2",
		usbfs: { busnum: 5, devnum: 36 },
		udev: {
			ID_MODEL_FROM_DATABASE: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		},
	},
	// The twin that LOST it and kept the kernel default name. Same SKU, one port
	// apart, and the board typed it `ethernet` while typing its twin `cellular`.
	eth1: {
		device: HUAWEI_HILINK,
		busId: "5-1.3.1",
		usbfs: { busnum: 5, devnum: 35 },
		udev: {
			ID_MODEL_FROM_DATABASE: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		},
	},
	wwu1u4u4i4: {
		device: QUECTEL_RM530N,
		busId: "8-1.4.4",
		usbfs: { busnum: 8, devnum: 7 },
	},
};

/** A shorter hwdb model, which some hwdb releases publish for the same SKU. */
const SHORT_HWDB_TREE: Record<string, FixtureDevice> = {
	eth1: {
		device: HUAWEI_HILINK,
		busId: "5-1.3.1",
		usbfs: { busnum: 5, devnum: 35 },
		udev: { ID_MODEL_FROM_DATABASE: "E3372" },
	},
};

function fixtureDeps(
	tree: Record<string, FixtureDevice>,
): RouterCellularScanDeps {
	const attrs = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	const links = new Map<string, string>();
	const driverLinks = new Map<string, string>();

	for (const [ifname, { device, busId, usbfs, udev }] of Object.entries(tree)) {
		const devDir = `/sys/devices/usb/${busId}`;
		attrs.set(`${devDir}/busnum`, String(usbfs.busnum));
		attrs.set(`${devDir}/devnum`, String(usbfs.devnum));
		if (udev) {
			const minor = (usbfs.busnum - 1) * 128 + (usbfs.devnum - 1);
			attrs.set(
				`/run/udev/data/c189:${minor}`,
				Object.entries(udev)
					.map(([key, value]) => `E:${key}=${value}`)
					.join("\n"),
			);
		}
		links.set(`/sys/class/net/${ifname}/device`, `${devDir}/${busId}:1.0`);
		attrs.set(`${devDir}/idVendor`, device.vendorId);
		attrs.set(`${devDir}/idProduct`, device.productId);
		attrs.set(
			`${devDir}/bDeviceClass`,
			device.bDeviceClass.toString(16).padStart(2, "0"),
		);
		if (device.manufacturer) {
			attrs.set(`${devDir}/manufacturer`, device.manufacturer);
		}
		if (device.product) attrs.set(`${devDir}/product`, device.product);

		const entries = ["power", "driver", "ep_00"];
		device.interfaces.forEach((iface, index) => {
			const name = `${busId}:1.${index}`;
			entries.push(name);
			attrs.set(
				`${devDir}/${name}/bInterfaceClass`,
				iface.interfaceClass.toString(16).padStart(2, "0"),
			);
			attrs.set(
				`${devDir}/${name}/bInterfaceSubClass`,
				iface.interfaceSubClass.toString(16).padStart(2, "0"),
			);
			attrs.set(
				`${devDir}/${name}/bInterfaceProtocol`,
				iface.interfaceProtocol.toString(16).padStart(2, "0"),
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

	return {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		listDir: async (path) => dirs.get(path) ?? [],
		readAttr: async (path) => attrs.get(path),
		resolveLink: async (path) => links.get(path),
		readLinkName: async (path) => driverLinks.get(path)?.split("/").pop(),
	};
}

/** Every interface the board enumerates, including the ones with no USB device. */
const BENCH_IFNAMES = [...Object.keys(BENCH_TREE), "eth0", "wlan0"];

async function loadBenchMarkers(
	tree: Record<string, FixtureDevice> = BENCH_TREE,
	ifnames: readonly string[] = BENCH_IFNAMES,
): Promise<void> {
	await refreshUsbNetMarkers(ifnames, fixtureDeps(tree));
}

beforeEach(() => {
	resetUsbNetMarkers();
});

afterEach(() => {
	resetUsbNetMarkers();
});

describe("uplink identity — kind derives from the device, not from the name", () => {
	it("types an eth-NAMED router dongle as cellular, and names it", async () => {
		await loadBenchMarkers();

		const identity = resolveUplinkIdentity("eth1");

		expect(identity.kind).toBe("cellular");
		expect(identity.displayName).toContain("Huawei E3372");
	});

	it("composes exactly `Huawei E3372` from a short hwdb model", async () => {
		await loadBenchMarkers(SHORT_HWDB_TREE, ["eth1"]);

		expect(resolveUplinkIdentity("eth1")).toEqual({
			kind: "cellular",
			displayName: "Huawei E3372",
		});
	});

	it("types both HiLink twins identically — one SKU, one port apart", async () => {
		await loadBenchMarkers();

		expect(resolveUplinkIdentity("eth1").kind).toBe("cellular");
		expect(resolveUplinkIdentity("enx0c5b8f279a64").kind).toBe("cellular");
	});

	it("names an MM-managed modem's data function after the modem", async () => {
		await loadBenchMarkers();

		expect(resolveUplinkIdentity("wwu1u4u4i4")).toEqual({
			kind: "cellular",
			displayName: "Quectel RM530N-GL",
		});
	});

	it("leaves a plain Ethernet port ethernet, with NO display name", async () => {
		await loadBenchMarkers();

		expect(resolveUplinkIdentity("eth0")).toEqual({ kind: "ethernet" });
	});

	it("still types a wifi radio as wifi", async () => {
		await loadBenchMarkers();

		expect(resolveUplinkIdentity("wlan0")).toEqual({ kind: "wifi" });
	});

	// The marker sweep is asynchronous and lands after the first health tick, so
	// this is a real steady state at boot — never a hypothetical.
	it("falls back to the pre-existing name ladder with NO markers loaded", () => {
		expect(resolveUplinkIdentity("eth1")).toEqual({ kind: "ethernet" });
		expect(resolveUplinkIdentity("wwu1u4u4i4")).toEqual({ kind: "cellular" });
		expect(resolveUplinkIdentity("ppp0")).toEqual({ kind: "cellular" });
		expect(resolveUplinkIdentity("tun0")).toEqual({ kind: "other" });
	});

	// `enx*` is systemd's predictable name for ANY USB network adapter, so
	// reading it as cellular is the coin-flip that typed one twin differently
	// from the other. Without a marker it is an Ethernet adapter, said plainly.
	it("never guesses cellular from an `enx` name alone", () => {
		expect(resolveUplinkIdentity("enx0c5b8f279a64")).toEqual({
			kind: "ethernet",
		});
	});
});

describe("uplink health records carry the name, and retract it", () => {
	it("stamps the resolved name onto a fresh record and onto the wire", async () => {
		await loadBenchMarkers();
		const engine = new UplinkHealthEngine();

		const record = engine.observe({
			iface: "eth1",
			...resolveUplinkIdentity("eth1"),
			outcome: "success",
			now: 1,
		});

		expect(record.kind).toBe("cellular");
		expect(record.displayName).toContain("Huawei E3372");
		expect(uplinkHealthRecordSchema.parse(record).displayName).toBe(
			record.displayName,
		);
	});

	it("omits the name entirely when the device could not be named", () => {
		const engine = new UplinkHealthEngine();

		const record = engine.observe({
			iface: "eth0",
			...resolveUplinkIdentity("eth0"),
			outcome: "success",
			now: 1,
		});

		expect("displayName" in record).toBe(false);
		expect(uplinkHealthRecordSchema.parse(record)).toEqual(record);
	});

	// A device that stops classifying must stop claiming a name, or the identity
	// latches onto whatever re-enumerates under that interface next.
	it("retracts a name that a later sweep no longer resolves", async () => {
		await loadBenchMarkers();
		const engine = new UplinkHealthEngine();

		engine.observe({
			iface: "eth1",
			...resolveUplinkIdentity("eth1"),
			outcome: "success",
			now: 1,
		});
		resetUsbNetMarkers();
		const retracted = engine.observe({
			iface: "eth1",
			...resolveUplinkIdentity("eth1"),
			outcome: "success",
			now: 2,
		});

		expect("displayName" in retracted).toBe(false);
	});

	it("keeps `iface` as the row identity", async () => {
		await loadBenchMarkers();
		const engine = new UplinkHealthEngine();

		for (const iface of ["eth1", "enx0c5b8f279a64"]) {
			engine.observe({
				iface,
				...resolveUplinkIdentity(iface),
				outcome: "success",
				now: 1,
			});
		}

		expect(engine.list().map((record) => record.iface)).toEqual([
			"enx0c5b8f279a64",
			"eth1",
		]);
	});
});
