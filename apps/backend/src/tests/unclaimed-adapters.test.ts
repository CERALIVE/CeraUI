import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";

import { unclaimedAdapterSchema } from "@ceraui/rpc/schemas";
import type WebSocket from "ws";
import { logger } from "../helpers/logger.ts";
import {
	getUnclaimedAdapters,
	refreshUnclaimedAdapters,
	resetUnclaimedAdapters,
	scanUnclaimedAdapters,
	type UnclaimedAdapterScanDeps,
} from "../modules/network/unclaimed-adapters.ts";
import { setup } from "../modules/setup.ts";
import { sendStatus } from "../modules/ui/status.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

/*
 * Every tree below is an in-memory sysfs shaped exactly like a real board's:
 * PCI functions under /sys/bus/pci/devices, USB devices AND their interface
 * nodes side by side in the flat /sys/bus/usb/devices directory.
 */

type PciFixture = {
	address: string;
	/** The full 24-bit sysfs `class` value, `0xCCSSPP`. */
	class: string;
	vendor: string;
	device: string;
	driver?: string;
};

type UsbInterfaceFixture = {
	suffix: string;
	interfaceClass: string;
	interfaceSubClass: string;
	interfaceProtocol: string;
	driver?: string;
};

type UsbFixture = {
	busId: string;
	idVendor: string;
	idProduct: string;
	/**
	 * The BUS driver bound to the parent device node. Real boards always have
	 * one (`usb`), bound or not — which is exactly why a probe may not read it.
	 */
	parentDriver?: string;
	interfaces: UsbInterfaceFixture[];
};

function fixtureDeps(tree: {
	pci?: PciFixture[];
	usb?: UsbFixture[];
}): UnclaimedAdapterScanDeps {
	const attrs = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	const driverLinks = new Map<string, string>();

	const pciRoot = "/sys/bus/pci/devices";
	dirs.set(
		pciRoot,
		(tree.pci ?? []).map((d) => d.address),
	);
	for (const fn of tree.pci ?? []) {
		const dir = `${pciRoot}/${fn.address}`;
		attrs.set(`${dir}/class`, fn.class);
		attrs.set(`${dir}/vendor`, fn.vendor);
		attrs.set(`${dir}/device`, fn.device);
		if (fn.driver) driverLinks.set(`${dir}/driver`, fn.driver);
	}

	const usbRoot = "/sys/bus/usb/devices";
	const usbEntries: string[] = [];
	for (const dev of tree.usb ?? []) {
		usbEntries.push(dev.busId);
		const parentDir = `${usbRoot}/${dev.busId}`;
		attrs.set(`${parentDir}/idVendor`, dev.idVendor);
		attrs.set(`${parentDir}/idProduct`, dev.idProduct);
		if (dev.parentDriver)
			driverLinks.set(`${parentDir}/driver`, dev.parentDriver);
		for (const iface of dev.interfaces) {
			const name = `${dev.busId}:${iface.suffix}`;
			usbEntries.push(name);
			const dir = `${usbRoot}/${name}`;
			attrs.set(`${dir}/bInterfaceClass`, iface.interfaceClass);
			attrs.set(`${dir}/bInterfaceSubClass`, iface.interfaceSubClass);
			attrs.set(`${dir}/bInterfaceProtocol`, iface.interfaceProtocol);
			if (iface.driver) driverLinks.set(`${dir}/driver`, iface.driver);
		}
	}
	dirs.set(usbRoot, usbEntries);

	return {
		sysfsRoot: "/",
		listDir: async (path) => {
			const entries = dirs.get(path);
			if (entries === undefined) throw new Error(`ENOENT: ${path}`);
			return entries;
		},
		readAttr: async (path) => attrs.get(path),
		readLinkName: async (path) => driverLinks.get(path),
	};
}

/** The Wireless Controller class + the Bluetooth programming interface triple. */
const BT_INTERFACE = {
	interfaceClass: "e0",
	interfaceSubClass: "01",
	interfaceProtocol: "01",
} as const;

/** A MediaTek MT7921 Wi-Fi function the shipped kernel binds no driver to. */
const MEDIATEK_PCIE_WIFI: PciFixture = {
	address: "0000:01:00.0",
	class: "0x028000",
	vendor: "0x14c3",
	device: "0x7961",
};

/** The bench's Intel Wi-Fi, bound — the control that keeps (a) non-vacuous. */
const INTEL_PCIE_WIFI_BOUND: PciFixture = {
	address: "0000:00:14.3",
	class: "0x028000",
	vendor: "0x8086",
	device: "0x2723",
	driver: "iwlwifi",
};

/**
 * BOTH dev boards' real state: a USB Bluetooth controller whose CLASS driver is
 * bound at the INTERFACE node, while the parent device node carries only the
 * bus driver. A probe that asked the parent would report this as driverless.
 */
const MEDIATEK_USB_BT_BOUND: UsbFixture = {
	busId: "1-1",
	idVendor: "0e8d",
	idProduct: "0608",
	parentDriver: "usb",
	interfaces: [
		{ suffix: "1.0", ...BT_INTERFACE, driver: "btusb" },
		{ suffix: "1.1", ...BT_INTERFACE, driver: "btusb" },
	],
};

/** The same shape with NOTHING bound at any interface — the reportable case. */
const REALTEK_USB_COMBO_UNBOUND: UsbFixture = {
	busId: "2-1",
	idVendor: "0bda",
	idProduct: "b82c",
	parentDriver: "usb",
	interfaces: [
		{ suffix: "1.0", ...BT_INTERFACE },
		{ suffix: "1.1", ...BT_INTERFACE },
		{
			suffix: "1.2",
			interfaceClass: "ff",
			interfaceSubClass: "ff",
			interfaceProtocol: "ff",
		},
	],
};

describe("unclaimed adapters — the PCI half", () => {
	it("reports an undriven MediaTek 14c3 PCIe function as an exact wire row", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({ pci: [MEDIATEK_PCIE_WIFI, INTEL_PCIE_WIFI_BOUND] }),
		);
		expect(rows).toEqual([
			{ bus: "pci", vendorId: "14c3", deviceId: "7961", kind: "wifi" },
		]);
	});

	it("names a 0x0d11 function as Bluetooth, not Wi-Fi", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({
				pci: [
					{
						address: "0000:02:00.0",
						class: "0x0d1100",
						vendor: "0x14c3",
						device: "0x7922",
					},
				],
			}),
		);
		expect(rows).toEqual([
			{ bus: "pci", vendorId: "14c3", deviceId: "7922", kind: "bluetooth" },
		]);
	});

	it("ignores a class this band does not speak for", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({
				pci: [
					{
						address: "0000:03:00.0",
						class: "0x020000",
						vendor: "0x10ec",
						device: "0x8168",
					},
				],
			}),
		);
		expect(rows).toEqual([]);
	});

	it("drops a function whose ids cannot be read rather than naming it blank", async () => {
		const deps = fixtureDeps({ pci: [MEDIATEK_PCIE_WIFI] });
		const rows = await scanUnclaimedAdapters({
			...deps,
			readAttr: async (path) =>
				path.endsWith("/device") ? undefined : await deps.readAttr(path),
		});
		expect(rows).toEqual([]);
	});
});

describe("unclaimed adapters — the USB half coalesces to the parent", () => {
	it("does NOT report a controller whose class driver is bound at the interface", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({ usb: [MEDIATEK_USB_BT_BOUND] }),
		);
		expect(rows).toEqual([]);
	});

	it("reports an all-unbound tree ONCE, keyed on the parent's ids", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({ usb: [REALTEK_USB_COMBO_UNBOUND] }),
		);
		expect(rows).toEqual([
			{ bus: "usb", vendorId: "0bda", deviceId: "b82c", kind: "bluetooth" },
		]);
	});

	it("separates the bound twin from the unbound one in ONE tree", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({
				usb: [MEDIATEK_USB_BT_BOUND, REALTEK_USB_COMBO_UNBOUND],
			}),
		);
		expect(rows.map((r) => r.vendorId)).toEqual(["0bda"]);
	});

	it("treats ANY bound class interface as proof the whole device is driven", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({
				usb: [
					{
						...REALTEK_USB_COMBO_UNBOUND,
						interfaces: [
							{ suffix: "1.0", ...BT_INTERFACE, driver: "btusb" },
							{ suffix: "1.1", ...BT_INTERFACE },
						],
					},
				],
			}),
		);
		expect(rows).toEqual([]);
	});

	it("names a non-Bluetooth wireless interface by its class, never by a guess at the part", async () => {
		const rows = await scanUnclaimedAdapters(
			fixtureDeps({
				usb: [
					{
						busId: "3-1",
						idVendor: "05c6",
						idProduct: "9024",
						parentDriver: "usb",
						interfaces: [
							{
								suffix: "1.0",
								interfaceClass: "e0",
								interfaceSubClass: "01",
								interfaceProtocol: "03",
							},
						],
					},
				],
			}),
		);
		expect(rows).toEqual([
			{ bus: "usb", vendorId: "05c6", deviceId: "9024", kind: "wireless" },
		]);
	});

	it("never reads the PARENT's driver symlink as the verdict", async () => {
		const probed: string[] = [];
		const deps = fixtureDeps({ usb: [MEDIATEK_USB_BT_BOUND] });
		await scanUnclaimedAdapters({
			...deps,
			readLinkName: async (path) => {
				probed.push(path);
				return await deps.readLinkName(path);
			},
		});
		expect(probed).not.toContain("/sys/bus/usb/devices/1-1/driver");
	});
});

describe("unclaimed adapters — the cached snapshot", () => {
	beforeEach(() => {
		resetUnclaimedAdapters();
	});

	it("answers UNDEFINED until the first probe, then an explicit empty array", async () => {
		expect(getUnclaimedAdapters()).toBeUndefined();
		await refreshUnclaimedAdapters(
			fixtureDeps({
				pci: [INTEL_PCIE_WIFI_BOUND],
				usb: [MEDIATEK_USB_BT_BOUND],
			}),
		);
		expect(getUnclaimedAdapters()).toEqual([]);
	});

	it("costs no log line and no second edge on an all-bound host", async () => {
		const deps = fixtureDeps({
			pci: [INTEL_PCIE_WIFI_BOUND],
			usb: [MEDIATEK_USB_BT_BOUND],
		});
		const info = spyOn(logger, "info");
		const warn = spyOn(logger, "warn");
		try {
			expect(await refreshUnclaimedAdapters(deps)).toBe(true);
			expect(await refreshUnclaimedAdapters(deps)).toBe(false);
			expect(await refreshUnclaimedAdapters(deps)).toBe(false);
			expect(info).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			info.mockRestore();
			warn.mockRestore();
		}
		expect(getUnclaimedAdapters()).toEqual([]);
	});

	it("reports an edge when an adapter appears and again when it is driven", async () => {
		const undriven = fixtureDeps({ pci: [MEDIATEK_PCIE_WIFI] });
		const driven = fixtureDeps({
			pci: [{ ...MEDIATEK_PCIE_WIFI, driver: "mt7921e" }],
		});
		expect(await refreshUnclaimedAdapters(undriven)).toBe(true);
		expect(await refreshUnclaimedAdapters(undriven)).toBe(false);
		expect(await refreshUnclaimedAdapters(driven)).toBe(true);
		expect(getUnclaimedAdapters()).toEqual([]);
	});

	it("degrades to an empty list when neither bus directory exists", async () => {
		const rows = await scanUnclaimedAdapters({
			sysfsRoot: "/",
			listDir: async () => {
				throw new Error("ENOENT");
			},
			readAttr: async () => undefined,
			readLinkName: async () => undefined,
		});
		expect(rows).toEqual([]);
	});
});

/*
 * A cached snapshot nobody publishes is a snapshot nobody has. These cases drive
 * the REAL status producers, because the getter was never the part that could be
 * wired wrong — the whole contract lives in the difference between an OMITTED
 * field and an explicit `[]`, which is a property of the serialized frame rather
 * than of the cache.
 */
describe("unclaimed adapters — the wire", () => {
	// sendStatus/buildInitialStatus fire getSshStatus, which rejects on a stray
	// setup.ssh_user a sibling test file may have left behind.
	let savedSshUser: string | undefined;
	beforeAll(() => {
		savedSshUser = setup.ssh_user;
		setup.ssh_user = undefined;
	});
	afterAll(() => {
		setup.ssh_user = savedSshUser;
		// Every other file in this process shares the cache; hand it back unasked.
		resetUnclaimedAdapters();
	});
	beforeEach(() => {
		resetUnclaimedAdapters();
	});

	/** The legacy relay producer, read back exactly as a client would see it. */
	function statusFrame(): Record<string, unknown> {
		const sent: string[] = [];
		sendStatus({
			send: (frame: string) => sent.push(frame),
		} as unknown as WebSocket);
		const parsed = JSON.parse(sent[0] ?? "{}") as {
			status?: Record<string, unknown>;
		};
		return parsed.status ?? {};
	}

	it("OMITS the field entirely until the probe has answered", () => {
		// Absence means UNASKED — an older backend, or a boot that has not reached
		// the first probe — and must never be readable as "everything is driven".
		expect("unclaimed_adapters" in statusFrame()).toBe(false);
		expect(buildInitialStatus().status.unclaimed_adapters).toBeUndefined();
	});

	it("publishes an EXPLICIT empty array once an all-bound host has been probed", async () => {
		await refreshUnclaimedAdapters(
			fixtureDeps({
				pci: [INTEL_PCIE_WIFI_BOUND],
				usb: [MEDIATEK_USB_BT_BOUND],
			}),
		);

		const frame = statusFrame();
		expect("unclaimed_adapters" in frame).toBe(true);
		expect(frame.unclaimed_adapters).toEqual([]);
		expect(buildInitialStatus().status.unclaimed_adapters).toEqual([]);
	});

	it("carries schema-valid rows on BOTH producers when a device is undriven", async () => {
		await refreshUnclaimedAdapters(
			fixtureDeps({
				pci: [MEDIATEK_PCIE_WIFI],
				usb: [REALTEK_USB_COMBO_UNBOUND],
			}),
		);

		const expected = [
			{ bus: "pci", vendorId: "14c3", deviceId: "7961", kind: "wifi" },
			{ bus: "usb", vendorId: "0bda", deviceId: "b82c", kind: "bluetooth" },
		];
		// buildInitialStatus is the path a browser takes (rpc/adapter.ts sends
		// `initialStatus.status`); sendStatus is the legacy relay one. Both must
		// carry it, or the field is dead on whichever half was missed.
		expect(statusFrame().unclaimed_adapters).toEqual(expected);
		expect(buildInitialStatus().status.unclaimed_adapters).toEqual(expected);
		for (const row of expected) {
			expect(unclaimedAdapterSchema.parse(row)).toEqual(row);
		}
	});

	it("retracts to an empty array once a driver binds — never raise-only", async () => {
		await refreshUnclaimedAdapters(fixtureDeps({ pci: [MEDIATEK_PCIE_WIFI] }));
		expect(statusFrame().unclaimed_adapters).toHaveLength(1);

		await refreshUnclaimedAdapters(
			fixtureDeps({ pci: [{ ...MEDIATEK_PCIE_WIFI, driver: "mt7921e" }] }),
		);
		expect(statusFrame().unclaimed_adapters).toEqual([]);
	});

	it("rides its OWN broadcast edge — its subject owns no netif row to travel on", async () => {
		// An undriven adapter has no network interface by definition, so the netif
		// diff can never see it change. The poller is module-private on purpose, so
		// this is a wiring lock rather than a behavioural one.
		const source = await Bun.file(
			new URL("../modules/network/network-interfaces.ts", import.meta.url)
				.pathname,
		).text();

		expect(source).toContain(
			'broadcastMsg("status", { unclaimed_adapters: getUnclaimedAdapters() })',
		);
	});
});
