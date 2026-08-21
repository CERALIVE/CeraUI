/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * The canonical physical-identity module, driven over the REAL fleet.
 *
 * Every fixture below is transcribed from the live board sweep of 2026-08-17
 * (`ceralive2`, todo 2), not imagined:
 *
 *   - a Qualcomm dual-mode stick that FLIPPED `05c6:9024` (`rndis_host`) ⇄
 *     `05c6:9091` (`qmi_wwan`) under a `uhubctl` power cycle while keeping ONE
 *     USB serial. Two such sticks are on the bench (`2b16081` at `1-1.4.1`,
 *     `c6125db3` at `1-1.4.3`); the flip was observed on the first and the plan
 *     names the second, so the fixtures carry both and assert the same property
 *     of each.
 *   - the two Huawei E3372 HiLink twins, which publish `HUAWEI_MOBILE` for both
 *     string descriptors, share ONE factory MAC, and expose NO usable USB serial
 *     at all — so nothing but the PORT can tell them apart.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
	fromMmcliModem,
	fromRouterCellularView,
} from "../modules/modems/modem-wire-adapters.ts";
import type { Modem } from "../modules/modems/modems-state.ts";
import {
	mintLinkId,
	type PhysicalDeviceRecord,
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
} from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import type {
	UsbInterfaceDescriptor,
	UsbNetDevice,
} from "../modules/network/usb-net-classifier.ts";

// ── the board's own descriptors ─────────────────────────────────────────────

const RNDIS_IFACES: UsbInterfaceDescriptor[] = [
	{
		interfaceClass: 0xe0,
		interfaceSubClass: 0x01,
		interfaceProtocol: 0x03,
		driver: "rndis_host",
	},
	{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x00 },
	{ interfaceClass: 0xff, interfaceSubClass: 0x42, interfaceProtocol: 0x01 },
];

const QMI_IFACES: UsbInterfaceDescriptor[] = [
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
];

function qualcomm(
	productId: "9024" | "9091",
	serialNumber: string,
): UsbNetDevice {
	return {
		vendorId: "05c6",
		productId,
		bDeviceClass: 0x00,
		manufacturer: "Android",
		product: "Android",
		serialNumber,
		interfaces: productId === "9024" ? RNDIS_IFACES : QMI_IFACES,
	};
}

/** The twins publish ONE string for both descriptors and NO serial. */
const HILINK: UsbNetDevice = {
	vendorId: "12d1",
	productId: "14dc",
	bDeviceClass: 0x00,
	manufacturer: "HUAWEI_MOBILE",
	product: "HUAWEI_MOBILE",
	interfaces: [
		{
			interfaceClass: 0x02,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x00,
			driver: "cdc_ether",
		},
		{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x00 },
		{
			interfaceClass: 0x08,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x50,
			driver: "usb-storage",
		},
	],
};

const HILINK_UDEV = {
	ID_VENDOR_FROM_DATABASE: "Huawei Technologies Co., Ltd.",
	ID_MODEL_FROM_DATABASE: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
};

/** The board's ID_PATH shape, from its own `udevadm` read of the FM350 slot. */
function idPathFor(busId: string): string {
	return `platform-xhci-hcd.0.auto-usb-0:${busId.replace(/^\d+-/, "")}`;
}

// ── an in-memory sysfs + udev tree, shaped like the board's ─────────────────

type FixtureDevice = {
	device: UsbNetDevice;
	busId: string;
	devnum: number;
	udev?: Readonly<Record<string, string>>;
};

function fixtureDeps(
	tree: Record<string, FixtureDevice>,
): RouterCellularScanDeps {
	const attrs = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	const links = new Map<string, string>();
	const driverLinks = new Map<string, string>();

	for (const [ifname, { device, busId, devnum, udev }] of Object.entries(
		tree,
	)) {
		const devDir = `/sys/devices/usb/${busId}`;
		attrs.set(`${devDir}/busnum`, "1");
		attrs.set(`${devDir}/devnum`, String(devnum));
		attrs.set(
			`/run/udev/data/c189:${devnum - 1}`,
			Object.entries({ ...(udev ?? {}), ID_PATH: idPathFor(busId) })
				.map(([k, v]) => `E:${k}=${v}`)
				.join("\n"),
		);
		links.set(`/sys/class/net/${ifname}/device`, `${devDir}/${busId}:1.0`);
		attrs.set(`${devDir}/idVendor`, device.vendorId);
		attrs.set(`${devDir}/idProduct`, device.productId);
		attrs.set(`${devDir}/bDeviceClass`, "00");
		if (device.manufacturer)
			attrs.set(`${devDir}/manufacturer`, device.manufacturer);
		if (device.product) attrs.set(`${devDir}/product`, device.product);
		if (device.serialNumber) attrs.set(`${devDir}/serial`, device.serialNumber);

		const entries = ["power", "driver"];
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

async function observe(
	tree: Record<string, FixtureDevice>,
	ifname: string,
	extra: Parameters<typeof resolveModemPhysicalIdentity>[1] = {},
): Promise<PhysicalDeviceRecord> {
	resetUsbNetMarkers();
	await refreshUsbNetMarkers(Object.keys(tree), fixtureDeps(tree));
	return resolveModemPhysicalIdentity(ifname, extra);
}

// The stick at C-3 in each of its two personalities. The interface names are
// DELIBERATELY unlike each other: a composition switch renames the data path,
// which is exactly why no rule here may read a name.
const RNDIS_TREE: Record<string, FixtureDevice> = {
	usb0: { device: qualcomm("9024", "c6125db3"), busId: "1-1.4.3", devnum: 41 },
};
const QMI_TREE: Record<string, FixtureDevice> = {
	wwan2: { device: qualcomm("9091", "c6125db3"), busId: "1-1.4.3", devnum: 44 },
};

const TWIN_TREE: Record<string, FixtureDevice> = {
	eth1: {
		device: HILINK,
		busId: "1-1.3.1",
		devnum: 28,
		udev: HILINK_UDEV,
	},
	enx0c5b8f279a64: {
		device: HILINK,
		busId: "1-1.3.2",
		devnum: 29,
		udev: HILINK_UDEV,
	},
};

beforeEach(() => {
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
});

describe("the dual-mode stick resolves to ONE identity in BOTH compositions", () => {
	it("keeps its identity and its link_id across the 9024 ⇄ 9091 flip", async () => {
		// Given the stick enumerated as an RNDIS router-class tether…
		const rndis = await observe(RNDIS_TREE, "usb0");
		// …and then, after a power cycle, as an MM-managed QMI modem.
		const qmi = await observe(QMI_TREE, "wwan2", {
			idPath: `${idPathFor("1-1.4.3")}:1.4`,
			mm: { name: "HIMI_U01_MODEM - 54863" },
		});

		expect(rndis.identityKey).toBe(qmi.identityKey);
		expect(rndis.linkId).toBe(qmi.linkId);
		// The VID:PID flapped and the interface name changed; neither may be an input.
		expect(rndis.pid).toBe("9024");
		expect(qmi.pid).toBe("9091");
		expect(rndis.ifname).not.toBe(qmi.ifname);
	});

	it("anchors that identity on the USB serial, which is what survived", async () => {
		const record = await observe(RNDIS_TREE, "usb0");
		expect(record.anchor).toBe("usb-serial");
		expect(record.serial).toBe("c6125db3");
		expect(record.identityKey).toBe("usb-serial:05c6:c6125db3");
	});

	it("does the same for the twin stick the flip was measured on", async () => {
		const tree = {
			usb0: {
				device: qualcomm("9024", "2b16081"),
				busId: "1-1.4.1",
				devnum: 39,
			},
		};
		const rndis = await observe(tree, "usb0");
		const qmi = await observe(
			{
				wwan1: {
					device: qualcomm("9091", "2b16081"),
					busId: "1-1.4.1",
					devnum: 40,
				},
			},
			"wwan1",
			{ mm: { name: "HIMI_U01_MODEM - 54863" } },
		);
		expect(rndis.linkId).toBe(qmi.linkId);
		// …and the two STICKS are still separate devices.
		const other = await observe(RNDIS_TREE, "usb0");
		expect(other.linkId).not.toBe(rndis.linkId);
	});

	it("titles it coherently in both compositions — never the class string", async () => {
		const rndis = await observe(RNDIS_TREE, "usb0");
		const qmi = await observe(QMI_TREE, "wwan2", {
			mm: { name: "HIMI_U01_MODEM - 54863" },
		});

		// `Android` is what BOTH descriptors publish, i.e. a device class. Neither
		// composition may print it.
		expect(rndis.displayName).not.toContain("Android");
		expect(qmi.displayName).not.toContain("Android");
		expect(rndis.displayName).toBe("Qualcomm 9024");
		expect(qmi.displayName).toBe("HIMI_U01_MODEM - 54863");
	});

	it("re-resolves to the same record on every poll of an unchanged device", async () => {
		const first = await observe(RNDIS_TREE, "usb0");
		const second = await observe(RNDIS_TREE, "usb0");
		expect(second).toEqual(first);
	});
});

describe("the HiLink twins have no serial, so identity is the PORT", () => {
	it("resolves the two units to DISTINCT identities", async () => {
		resetUsbNetMarkers();
		await refreshUsbNetMarkers(Object.keys(TWIN_TREE), fixtureDeps(TWIN_TREE));
		const a = resolveModemPhysicalIdentity("eth1");
		const b = resolveModemPhysicalIdentity("enx0c5b8f279a64");

		expect(a.serial).toBeUndefined();
		expect(b.serial).toBeUndefined();
		expect(a.anchor).toBe("id-path");
		expect(b.anchor).toBe("id-path");
		expect(a.identityKey).not.toBe(b.identityKey);
		expect(a.linkId).not.toBe(b.linkId);
	});

	it("is stable across a replug into the SAME port, name change and all", async () => {
		// systemd's MAC-derived rename races between the two units, so the same
		// physical dongle can come back under the other name.
		const before = await observe(
			{ eth1: TWIN_TREE.eth1 as FixtureDevice },
			"eth1",
		);
		const after = await observe(
			{ enx0c5b8f279a64: TWIN_TREE.eth1 as FixtureDevice },
			"enx0c5b8f279a64",
		);
		expect(after.identityKey).toBe(before.identityKey);
		expect(after.linkId).toBe(before.linkId);
	});

	it("is DIFFERENT when the unit is moved to another port, deliberately", async () => {
		const atB1 = await observe(
			{ eth1: TWIN_TREE.eth1 as FixtureDevice },
			"eth1",
		);
		const atB2 = await observe(
			{
				eth1: {
					device: HILINK,
					busId: "1-1.3.4",
					devnum: 31,
					udev: HILINK_UDEV,
				},
			},
			"eth1",
		);
		expect(atB2.linkId).not.toBe(atB1.linkId);
	});

	it("recovers the real model from the hwdb rather than printing the class", async () => {
		const record = await observe(
			{ eth1: TWIN_TREE.eth1 as FixtureDevice },
			"eth1",
		);
		expect(record.displayName).toBe(
			"Huawei E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		);
		expect(record.hwdb?.model).toContain("E3372");
	});
});

describe("link_id minting", () => {
	it("is deterministic, so it survives a reload with no persisted state", () => {
		const first = mintLinkId("usb-serial:05c6:c6125db3");
		resetPhysicalIdentityRegistry();
		expect(mintLinkId("usb-serial:05c6:c6125db3")).toBe(first);
		expect(first).toMatch(/^lnk_[0-9a-f]{16}$/);
	});

	it("never carries the serial it was derived from", () => {
		expect(mintLinkId("usb-serial:05c6:c6125db3")).not.toContain("c6125db3");
	});

	it("separates two identities that differ only by port", () => {
		expect(mintLinkId("id-path:x-usb-0:1.3.1")).not.toBe(
			mintLinkId("id-path:x-usb-0:1.3.2"),
		);
	});
});

describe("the wired consumers", () => {
	it("gives the direct router adapter a REAL stable_key instead of an ifname", async () => {
		const identity = await observe(
			{ eth1: TWIN_TREE.eth1 as FixtureDevice },
			"eth1",
		);
		const source = fromRouterCellularView({
			ifname: "eth1",
			vendor: "Huawei",
			model: "E3372",
			vidPid: "12d1:14dc",
			hasAddress: true,
			identity,
		});

		expect(source.stableKey).toBe(idPathFor("1-1.3.1"));
		expect(source.allocationKey).toBe(idPathFor("1-1.3.1"));
		expect(source.allocationKey).not.toContain("eth1");
	});

	it("keeps the ifname fallback when no identity could be anchored", () => {
		const source = fromRouterCellularView({
			ifname: "eth1",
			vendor: "Huawei",
			model: "E3372",
			vidPid: "12d1:14dc",
			hasAddress: true,
		});
		expect(source.stableKey).toBeUndefined();
		expect(source.allocationKey).toBe("router-cellular:eth1");
	});

	it("leaves the mmcli row's stable_key byte-identical to the ID_PATH rule", () => {
		const modem = {
			ifname: "wwan2",
			name: "HIMI_U01_MODEM - 54863",
			sim_network: "<NO SIM>",
			network_type: { supported: {}, active: null },
			status: {
				connection: "failed",
				network_type: "",
				signal: 0,
				roaming: false,
			},
		} as unknown as Modem;

		const withIdPath = fromMmcliModem(6, modem, {
			idPath: `${idPathFor("1-1.4.3")}:1.4`,
		});
		expect(withIdPath.stableKey).toBe(idPathFor("1-1.4.3"));

		// …and an identity supplies the key only when the adapter had none.
		const identity = resolvePhysicalDevice({
			ifname: "wwan2",
			idPath: `${idPathFor("1-1.4.3")}:1.4`,
		});
		expect(fromMmcliModem(6, modem, { identity }).stableKey).toBe(
			idPathFor("1-1.4.3"),
		);
	});
});

describe("the HIMI firmware-string fallback chain is layered on, not replaced", () => {
	it("still titles a garbage-identity modem from its firmware string", () => {
		const record = resolvePhysicalDevice({
			ifname: "wwan2",
			idPath: idPathFor("1-1.4.3"),
			mm: {
				name: "0 - 72633",
				model: "0",
				manufacturer: "1",
				firmwareRevision: "HIMI_U01_MODEM_V2.0  1  [May 13 2022 13:00:00]",
				equipmentId: "868837088254863",
			},
		});
		expect(record.displayName).toBe("HIMI_U01_MODEM_V2.0 - 54863");
	});

	it("prefers a real model over every other layer", () => {
		const record = resolvePhysicalDevice({
			ifname: "wwan3",
			idPath: idPathFor("1-1.4.4"),
			descriptorVendor: "Quectel",
			descriptorModel: "0801",
			mm: { model: "RM530N-GL", equipmentId: "123456789012345" },
		});
		expect(record.displayName).toBe("RM530N-GL - 12345");
	});
});
