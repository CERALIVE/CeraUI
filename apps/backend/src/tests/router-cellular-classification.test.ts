/*
 * Router-mode cellular classification — descriptors decide, names never do.
 *
 * Every device fixture below is a VERBATIM transcription of a sysfs read taken
 * from the CeraLive bench board (`ceralive2`, RK3588, 2026-08-16): the two
 * Huawei HiLink units, the ZTE MF79U-class dongle, the Quectel RM530N-GL and
 * the SIMCom module. They are captured hardware, not invented shapes — a fixture
 * someone made up could not have caught the case this suite exists for.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
	netIfBuildMsg,
	processIfconfigOutput,
	resetDongleMarkerTracking,
	resetModemNetTracking,
	resetRouterCellularTracking,
} from "../modules/network/network-interfaces.ts";
import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	scanRouterCellular,
	scanUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import {
	cellularEvidence,
	classifyUsbNetDevice,
	type UsbNetDevice,
} from "../modules/network/usb-net-classifier.ts";

// ── Captured hardware ───────────────────────────────────────────────────────

/** Huawei HiLink `12d1:14dc`: CDC-ECM control + CDC data + ZeroCD storage LUN. */
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

/** ZTE MF79U-class `19d2:1405`. Note `bDeviceClass` 0x00, unlike the Huawei. */
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

/** Quectel RM530N-GL `2c7c:0801`: four AT ports plus a QMI port. */
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
			interfaceProtocol: 0x30,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x40,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0xff,
			interfaceProtocol: 0xff,
			driver: "qmi_wwan",
		},
	],
};

/** SIMCom `1e0e:9001` — same shape, a different cellular vendor id. */
const SIMCOM: UsbNetDevice = {
	vendorId: "1e0e",
	productId: "9001",
	bDeviceClass: 0x00,
	manufacturer: "SimTech, Incorporated",
	product: "SimTech, Incorporated",
	interfaces: [
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0xff,
			interfaceProtocol: 0xff,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0xff,
			interfaceProtocol: 0xff,
			driver: "qmi_wwan",
		},
	],
};

/** A plain USB-to-Ethernet adapter: the same tether, none of the evidence. */
const ASIX_USB_NIC: UsbNetDevice = {
	vendorId: "0b95",
	productId: "1790",
	bDeviceClass: 0x00,
	manufacturer: "ASIX Elec. Corp.",
	product: "AX88179",
	interfaces: [
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0xff,
			interfaceProtocol: 0x00,
			driver: "ax88179_178a",
		},
		{
			interfaceClass: 0x02,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x00,
			driver: "cdc_ether",
		},
	],
};

/**
 * Qualcomm reference RNDIS stick `05c6:9024`, captured 2026-08-17. It publishes
 * `Android` for BOTH string descriptors — a device CLASS, so neither field is an
 * identity — and the bench carries TWO of them with distinct serials.
 */
function qualcommStick(serialNumber: string): UsbNetDevice {
	return {
		vendorId: "05c6",
		productId: "9024",
		bDeviceClass: 0x00,
		manufacturer: "Android",
		product: "Android",
		serialNumber,
		interfaces: [
			{
				interfaceClass: 0xe0,
				interfaceSubClass: 0x01,
				interfaceProtocol: 0x03,
				driver: "rndis_host",
			},
			{
				interfaceClass: 0x0a,
				interfaceSubClass: 0x00,
				interfaceProtocol: 0x00,
				driver: "rndis_host",
			},
			// Android ADB, no driver bound — deliberately NOT an AT control port.
			{
				interfaceClass: 0xff,
				interfaceSubClass: 0x42,
				interfaceProtocol: 0x01,
			},
		],
	};
}

/**
 * Fibocom FM350-GL `0e8d:7127`, captured 2026-08-17 through its M.2-to-USB
 * bench adapter. Seven `option`-bound serial ports make it MM-manageable, and
 * its DATA path is RNDIS — so its net interface is named after its MAC
 * (`enx000011121314`) and no ifname prefix can recognise it.
 */
const FIBOCOM_FM350: UsbNetDevice = {
	vendorId: "0e8d",
	productId: "7127",
	bDeviceClass: 0xef,
	manufacturer: "Fibocom Wireless Inc.",
	product: "FM350-GL",
	interfaces: [
		{
			interfaceClass: 0x02,
			interfaceSubClass: 0x02,
			interfaceProtocol: 0xff,
			driver: "rndis_host",
		},
		{
			interfaceClass: 0x0a,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "rndis_host",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: "option",
		},
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0x42,
			interfaceProtocol: 0x01,
		},
	],
};

describe("classifyUsbNetDevice — the bench hardware", () => {
	it("calls both router dongles router-cellular", () => {
		expect(classifyUsbNetDevice(HUAWEI_HILINK).deviceClass).toBe(
			"router-cellular",
		);
		expect(classifyUsbNetDevice(ZTE_MF79U).deviceClass).toBe("router-cellular");
	});

	it("leaves an MM-managed modem to the Cellular section", () => {
		expect(classifyUsbNetDevice(QUECTEL_RM530N).deviceClass).toBe("mm-managed");
		expect(classifyUsbNetDevice(SIMCOM).deviceClass).toBe("mm-managed");
	});

	it("never claims a plain USB-Ethernet adapter is cellular", () => {
		// It presents the SAME CDC-ECM tether as the dongles. Only the absence of
		// cellular evidence separates them, which is the whole reason the evidence
		// gate exists on top of modem-stack's `router-mode` verdict.
		const verdict = classifyUsbNetDevice(ASIX_USB_NIC);
		expect(verdict.deviceClass).toBe("wired-ethernet");
		expect(cellularEvidence(ASIX_USB_NIC)).toBeUndefined();
	});

	it("recognises an unlisted vendor's dongle by its ZeroCD companion alone", () => {
		const unlisted: UsbNetDevice = {
			...HUAWEI_HILINK,
			vendorId: "abcd",
			productId: "0001",
			manufacturer: "Unlisted Telecom",
			product: "Some Dongle",
		};
		expect(cellularEvidence(unlisted)).toContain("mass-storage");
		expect(classifyUsbNetDevice(unlisted).deviceClass).toBe("router-cellular");
	});

	it("states its evidence rather than asserting a bare verdict", () => {
		expect(classifyUsbNetDevice(HUAWEI_HILINK).reason).toContain("12d1");
		expect(classifyUsbNetDevice(QUECTEL_RM530N).reason).toContain(
			"control interface",
		);
		expect(classifyUsbNetDevice(ASIX_USB_NIC).reason).toContain(
			"no cellular evidence",
		);
	});
});

// ── The sysfs seam, driven over a fixture tree ──────────────────────────────

type FixtureDevice = {
	device: UsbNetDevice;
	busId: string;
	/** usbfs coordinates, which is what keys the device's udev database entry. */
	usbfs?: { busnum: number; devnum: number };
	/** The `E:`-prefixed property lines udev recorded for the USB device. */
	udev?: Readonly<Record<string, string>>;
};

/**
 * Build scan deps over an in-memory sysfs tree shaped exactly like the board's:
 * `/sys/class/net/<if>/device` → `<devdir>/<busid>:1.<n>`, whose PARENT carries
 * the ids and every sibling interface directory.
 */
function fixtureDeps(
	tree: Record<string, FixtureDevice>,
): RouterCellularScanDeps {
	const attrs = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	const links = new Map<string, string>();
	const driverLinks = new Map<string, string>();

	for (const [ifname, { device, busId, usbfs, udev }] of Object.entries(tree)) {
		const devDir = `/sys/devices/usb/${busId}`;
		if (usbfs) {
			attrs.set(`${devDir}/busnum`, String(usbfs.busnum));
			attrs.set(`${devDir}/devnum`, String(usbfs.devnum));
			const minor = (usbfs.busnum - 1) * 128 + (usbfs.devnum - 1);
			if (udev) {
				attrs.set(
					`/run/udev/data/c189:${minor}`,
					Object.entries(udev)
						.map(([k, v]) => `E:${k}=${v}`)
						.join("\n"),
				);
			}
		}
		// The netdev always hangs off interface 0 on this hardware.
		links.set(`/sys/class/net/${ifname}/device`, `${devDir}/${busId}:1.0`);
		attrs.set(`${devDir}/idVendor`, device.vendorId);
		attrs.set(`${devDir}/idProduct`, device.productId);
		attrs.set(
			`${devDir}/bDeviceClass`,
			device.bDeviceClass.toString(16).padStart(2, "0"),
		);
		if (device.manufacturer)
			attrs.set(`${devDir}/manufacturer`, device.manufacturer);
		if (device.product) attrs.set(`${devDir}/product`, device.product);
		if (device.serialNumber) attrs.set(`${devDir}/serial`, device.serialNumber);

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

// `usbfs` / `udev` are transcribed from the same board as the descriptors above:
// `busnum`/`devnum` out of sysfs, and the `E:` lines out of the USB device's own
// `/run/udev/data/c189:<minor>` entry. Note what the Huawei entries carry and the
// ZTE entry does not — usb.ids has a MODEL for `12d1:14dc` and only a vendor for
// `19d2:1405`, which is what makes the substitution rule below asymmetric.
const HUAWEI_UDEV = {
	ID_VENDOR_FROM_DATABASE: "Huawei Technologies Co., Ltd.",
	ID_MODEL_FROM_DATABASE: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
};

const BENCH_TREE: Record<string, FixtureDevice> = {
	enx0c5b8f279a64: {
		device: HUAWEI_HILINK,
		busId: "1-1.3.2",
		usbfs: { busnum: 1, devnum: 29 },
		udev: HUAWEI_UDEV,
	},
	eth1: {
		device: HUAWEI_HILINK,
		busId: "1-1.3.1",
		usbfs: { busnum: 1, devnum: 28 },
		udev: HUAWEI_UDEV,
	},
	enx344b50000000: {
		device: ZTE_MF79U,
		busId: "1-1.1",
		usbfs: { busnum: 1, devnum: 13 },
		udev: { ID_VENDOR_FROM_DATABASE: "ZTE WCDMA Technologies MSM" },
	},
	wwan0: { device: QUECTEL_RM530N, busId: "4-1.4.4" },
	wwan1: { device: SIMCOM, busId: "1-1.3.4" },
};

const QUALCOMM_UDEV = { ID_VENDOR_FROM_DATABASE: "Qualcomm, Inc." };

/** The 2026-08-17 roster: the tree above plus the twin sticks and the FM350. */
const BENCH_TREE_2026_08_17: Record<string, FixtureDevice> = {
	...BENCH_TREE,
	enx020754023235: {
		device: qualcommStick("c6125db3"),
		busId: "1-1.4.3",
		usbfs: { busnum: 1, devnum: 15 },
		udev: QUALCOMM_UDEV,
	},
	enx020a53313630: {
		device: qualcommStick("2b16081"),
		busId: "1-1.4.1",
		usbfs: { busnum: 1, devnum: 17 },
		udev: QUALCOMM_UDEV,
	},
	enx000011121314: {
		device: FIBOCOM_FM350,
		busId: "1-1.2",
		usbfs: { busnum: 1, devnum: 19 },
		udev: { ID_VENDOR_FROM_DATABASE: "MediaTek Inc." },
	},
};

describe("scanRouterCellular — the live bench topology", () => {
	beforeEach(() => {
		resetUsbNetMarkers();
		resetRouterCellularTracking();
		resetDongleMarkerTracking();
	});

	it("marks exactly the three router dongles", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE),
			fixtureDeps(BENCH_TREE),
		);
		expect([...markers.keys()].sort()).toEqual([
			"enx0c5b8f279a64",
			"enx344b50000000",
			"eth1",
		]);
	});

	it("carries the device's own identity, not a derived one", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE),
			fixtureDeps(BENCH_TREE),
		);
		expect(markers.get("enx344b50000000")).toEqual({
			vendor: "ZTE,Incorporated",
			model: "ZTE Mobile Boardband",
			vid_pid: "19d2:1405",
			kind: "router-cellular",
			duplicate_model: false,
		});
	});

	// Operator-reported: both HiLink rows read `HUAWEI_MOBILE` where a model
	// belongs, so the two units were indistinguishable and neither was named.
	it("recovers a real model for a dongle that publishes a device-CLASS string", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE),
			fixtureDeps(BENCH_TREE),
		);
		for (const ifname of ["enx0c5b8f279a64", "eth1"]) {
			expect(markers.get(ifname)?.model).toBe(
				"E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
			);
			expect(markers.get(ifname)?.vendor).toBe("Huawei");
			expect(markers.get(ifname)?.model).not.toBe("HUAWEI_MOBILE");
			expect(markers.get(ifname)?.vendor).not.toBe("HUAWEI_MOBILE");
		}
	});

	// The substitution may only fire for a device that named a CLASS. A device
	// that distinguished its two descriptors keeps its own words — including the
	// hwdb vendor being WORSE than the device's own (`ZTE WCDMA Technologies
	// MSM` is the USB-IF registration, not the brand on the casing).
	it("leaves a device that named itself completely untouched", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE),
			fixtureDeps(BENCH_TREE),
		);
		expect(markers.get("enx344b50000000")?.vendor).toBe("ZTE,Incorporated");
		expect(markers.get("enx344b50000000")?.model).toBe("ZTE Mobile Boardband");
	});

	// The udev database read must never become a REQUIREMENT: an image with no
	// hwdb, a device udev has not processed, or an unreadable entry must all
	// still yield an identity rather than a blank one. What it must NOT do is
	// re-print the class string the device published: that string has already
	// been measured to name a class, so the bare product id is the honest floor.
	it("degrades to the product id, never back to the class string", async () => {
		const withoutUdev: Record<string, FixtureDevice> = {
			enx0c5b8f279a64: { device: HUAWEI_HILINK, busId: "1-1.3.2" },
		};
		const markers = await scanRouterCellular(
			Object.keys(withoutUdev),
			fixtureDeps(withoutUdev),
		);
		expect(markers.get("enx0c5b8f279a64")).toMatchObject({
			vendor: "Huawei",
			model: "14dc",
		});
		expect(markers.get("enx0c5b8f279a64")?.model).not.toBe("HUAWEI_MOBILE");
	});

	it("flags the same-model pair and only the pair", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE),
			fixtureDeps(BENCH_TREE),
		);
		expect(markers.get("enx0c5b8f279a64")?.duplicate_model).toBe(true);
		expect(markers.get("eth1")?.duplicate_model).toBe(true);
		expect(markers.get("enx344b50000000")?.duplicate_model).toBe(false);
	});

	it("classifies an interface with NO USB device behind it as nothing at all", async () => {
		const markers = await scanRouterCellular(
			["eth0", "wlan0"],
			fixtureDeps(BENCH_TREE),
		);
		expect(markers.size).toBe(0);
	});

	// THE POINT OF THIS SUITE. `eth1` and `enx0c5b8f279a64` above are already
	// one model under two naming schemes, so the classification cannot be reading
	// a prefix. This proves it directly: rename every interface to something no
	// rule could have an opinion about and the verdicts must not move.
	it("is driven by descriptors, not by the interface name", async () => {
		const renamed: Record<string, FixtureDevice> = {};
		const rename = new Map<string, string>();
		Object.entries(BENCH_TREE).forEach(([ifname, entry], index) => {
			const alias = `zz${index}qq`;
			rename.set(ifname, alias);
			renamed[alias] = entry;
		});

		const original = await scanRouterCellular(
			Object.keys(BENCH_TREE),
			fixtureDeps(BENCH_TREE),
		);
		const aliased = await scanRouterCellular(
			Object.keys(renamed),
			fixtureDeps(renamed),
		);

		expect(aliased.size).toBe(original.size);
		for (const [ifname, marker] of original) {
			const alias = rename.get(ifname);
			expect(alias).toBeDefined();
			expect(aliased.get(alias as string)).toEqual(marker);
		}
		// And none of the aliases carries an `enx`/`eth`/`ww` prefix, so a rule
		// that keyed on one would have produced an empty map above.
		for (const alias of rename.values()) {
			expect(alias).not.toMatch(/^(?:enx|eth|ww|wlan|usb)/);
		}
	});
});

describe("the netif wire projection", () => {
	beforeEach(() => {
		resetUsbNetMarkers();
		resetRouterCellularTracking();
		resetDongleMarkerTracking();
	});

	// ifconfig text for the two HiLink units, both leasing the SAME address —
	// the real collision this bench reproduces.
	const IFCONFIG = `enx0c5b8f279a64: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.8.100  netmask 255.255.255.0
        RX packets 10  bytes 1000
        TX packets 10  bytes 2000

eth1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.8.100  netmask 255.255.255.0
        RX packets 10  bytes 1000
        TX packets 10  bytes 2000

eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.78.132  netmask 255.255.255.0
        RX packets 10  bytes 1000
        TX packets 10  bytes 2000
`;

	it("stamps the marker on the classified rows and nothing else", async () => {
		processIfconfigOutput(IFCONFIG);
		await refreshUsbNetMarkers(
			["enx0c5b8f279a64", "eth1", "eth0"],
			fixtureDeps(BENCH_TREE),
		);

		const msg = netIfBuildMsg();
		expect(msg.enx0c5b8f279a64?.router_cellular?.kind).toBe("router-cellular");
		expect(msg.eth1?.router_cellular?.duplicate_model).toBe(true);
		expect(msg.eth0?.router_cellular).toBeUndefined();
	});

	it("retracts with ONE explicit null and keeps the row", async () => {
		processIfconfigOutput(IFCONFIG);
		await refreshUsbNetMarkers(
			["enx0c5b8f279a64", "eth1", "eth0"],
			fixtureDeps(BENCH_TREE),
		);
		netIfBuildMsg();

		// The dongle was unplugged and something non-cellular took its place: the
		// interface is still enumerated, it simply stopped classifying.
		await refreshUsbNetMarkers(
			["enx0c5b8f279a64", "eth1", "eth0"],
			fixtureDeps({}),
		);

		const retraction = netIfBuildMsg();
		expect(retraction.enx0c5b8f279a64).toBeDefined();
		expect(retraction.enx0c5b8f279a64?.router_cellular).toBeNull();

		// ONE frame only — a marker that kept re-announcing its own absence would
		// make the retraction indistinguishable from a permanent claim.
		const after = netIfBuildMsg();
		expect("router_cellular" in (after.enx0c5b8f279a64 ?? {})).toBe(false);
	});
});

/*
 * Todo 66 — the two things the 2026-08-17 bench roster exposed.
 *
 * (a) Both `05c6:9024` sticks reached the operator as "Android". The classifier
 *     was right about WHAT they are; the NAME beside it re-printed the very
 *     class string `publishesGenericIdentity` had just measured to be worthless.
 * (b) The Fibocom FM350-GL's RNDIS data function rendered as a second,
 *     unexplained Ethernet row for a device the Cellular section already owned.
 */
describe("a device that names a CLASS is never named by that class", () => {
	beforeEach(() => {
		resetUsbNetMarkers();
		resetRouterCellularTracking();
		resetModemNetTracking();
		resetDongleMarkerTracking();
	});

	it("names the Qualcomm sticks by their USB-IF vendor and product id", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE_2026_08_17),
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		for (const ifname of ["enx020754023235", "enx020a53313630"]) {
			const marker = markers.get(ifname);
			expect(marker?.vendor).toBe("Qualcomm");
			expect(marker?.model).toBe("9024");
			expect(marker?.vid_pid).toBe("05c6:9024");
			// The whole defect, asserted directly.
			expect(marker?.vendor).not.toBe("Android");
			expect(marker?.model).not.toBe("Android");
		}
	});

	// Two units of one SKU are identical in vendor, model and vid:pid alike, so
	// the serial is the ONLY thing that separates their rows.
	it("carries each twin's own serial, and only because a twin is attached", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE_2026_08_17),
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		expect(markers.get("enx020754023235")?.serial).toBe("c6125db3");
		expect(markers.get("enx020a53313630")?.serial).toBe("2b16081");
		expect(markers.get("enx020754023235")?.duplicate_model).toBe(true);
	});

	it("withholds the serial from a lone device, which needs no discriminator", async () => {
		const lone: Record<string, FixtureDevice> = {
			enx020a53313630: {
				device: qualcommStick("2b16081"),
				busId: "1-1.4.1",
				usbfs: { busnum: 1, devnum: 17 },
				udev: QUALCOMM_UDEV,
			},
		};
		const markers = await scanRouterCellular(
			Object.keys(lone),
			fixtureDeps(lone),
		);

		expect(markers.get("enx020a53313630")?.duplicate_model).toBe(false);
		expect(markers.get("enx020a53313630")?.serial).toBeUndefined();
	});

	// The HiLink pair publishes no serial at all, so it gets no discriminator
	// rather than an invented one — even though it IS a duplicate model.
	it("invents no discriminator for a twin pair that publishes none", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE_2026_08_17),
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		expect(markers.get("eth1")?.duplicate_model).toBe(true);
		expect(markers.get("eth1")?.serial).toBeUndefined();
	});

	it("leaves every device that named itself byte-unchanged", async () => {
		const markers = await scanRouterCellular(
			Object.keys(BENCH_TREE_2026_08_17),
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		expect(markers.get("enx344b50000000")).toEqual({
			vendor: "ZTE,Incorporated",
			model: "ZTE Mobile Boardband",
			vid_pid: "19d2:1405",
			kind: "router-cellular",
			duplicate_model: false,
		});
	});
});

describe("an MM-managed modem's data function is recognised as one", () => {
	beforeEach(() => {
		resetUsbNetMarkers();
		resetRouterCellularTracking();
		resetModemNetTracking();
		resetDongleMarkerTracking();
	});

	it("marks the FM350's RNDIS interface, and never as a router dongle", async () => {
		const { routerCellular, modemNet } = await scanUsbNetMarkers(
			Object.keys(BENCH_TREE_2026_08_17),
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		expect(modemNet.get("enx000011121314")).toEqual({
			vendor: "Fibocom Wireless Inc.",
			model: "FM350-GL",
			vid_pid: "0e8d:7127",
			kind: "modem-net",
		});
		expect(routerCellular.has("enx000011121314")).toBe(false);
	});

	// The two marker sets must never overlap: a row carrying both would be
	// claimed by two different rules at once.
	it("keeps the two marker sets disjoint across the whole roster", async () => {
		const { routerCellular, modemNet } = await scanUsbNetMarkers(
			Object.keys(BENCH_TREE_2026_08_17),
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		for (const ifname of modemNet.keys()) {
			expect(routerCellular.has(ifname)).toBe(false);
		}
		expect([...modemNet.keys()].sort()).toEqual([
			"enx000011121314",
			"wwan0",
			"wwan1",
		]);
	});

	it("stamps and retracts on the wire exactly like the router marker", async () => {
		processIfconfigOutput(`enx000011121314: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        RX packets 0  bytes 0
        TX packets 3  bytes 657

eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.78.132  netmask 255.255.255.0
        RX packets 10  bytes 1000
        TX packets 10  bytes 2000
`);
		await refreshUsbNetMarkers(
			["enx000011121314", "eth0"],
			fixtureDeps(BENCH_TREE_2026_08_17),
		);

		const msg = netIfBuildMsg();
		expect(msg.enx000011121314?.usb_modem_net?.model).toBe("FM350-GL");
		expect(msg.eth0?.usb_modem_net).toBeUndefined();

		await refreshUsbNetMarkers(["enx000011121314", "eth0"], fixtureDeps({}));

		const retraction = netIfBuildMsg();
		expect(retraction.enx000011121314).toBeDefined();
		expect(retraction.enx000011121314?.usb_modem_net).toBeNull();

		const after = netIfBuildMsg();
		expect("usb_modem_net" in (after.enx000011121314 ?? {})).toBe(false);
	});
});
