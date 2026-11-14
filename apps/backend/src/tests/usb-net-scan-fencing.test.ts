/*
 * Overlapping USB-net sweeps may not commit out of order.
 *
 * The ordering here is CONTROLLED, never timed: the older sweep is held at its
 * first sysfs read by a manually-resolved promise, and the newer sweep is
 * awaited to completion before that gate is opened. So "the older result lands
 * last" is a fact of the test's own control flow rather than of a `sleep` that
 * a slow machine could invert.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getRouterCellularMarker,
	getUsbPhysicalDescriptor,
	identityDeadlineExpired,
	notePublishedNetifSnapshot,
	onUsbNetScanCommitted,
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	scanUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import type { UsbNetDevice } from "../modules/network/usb-net-classifier.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

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

	// The marker cache is process-wide and Bun shares one process across test
	// files, so clearing only on entry leaves this file's LAST sweep behind for
	// every later file — which is exactly how a `eth1` marker reached the
	// `modems` wire projection and gave its roster a synthetic row.
	afterEach(() => {
		resetUsbNetMarkers();
	});

	it("covers completed reads without a USB descriptor and publishes coverage changes once", async () => {
		const empty = fixture({});
		let commits = 0;
		const unsubscribe = onUsbNetScanCommitted(() => {
			commits++;
		});
		try {
			expect(usbNetScanCovers("eth0")).toBe(false);
			expect(await refreshUsbNetMarkers(["eth0"], empty.deps)).toBe(true);
			expect(usbNetScanCovers("eth0")).toBe(true);
			expect(await refreshUsbNetMarkers(["eth0"], empty.deps)).toBe(false);
			expect(commits).toBe(1);
		} finally {
			unsubscribe();
		}
	});

	it("shares a publication deadline and resets it when the name disappears", () => {
		notePublishedNetifSnapshot(["wwan0"], 500);
		notePublishedNetifSnapshot(["wwan0"], 2_000);
		expect(identityDeadlineExpired("wwan0", 15_499)).toBe(false);
		expect(identityDeadlineExpired("wwan0", 15_500)).toBe(true);
		notePublishedNetifSnapshot([], 16_000);
		notePublishedNetifSnapshot(["wwan0"], 17_000);
		expect(identityDeadlineExpired("wwan0", 17_000)).toBe(false);
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

describe("shared USB serials are remembered only by committed scans", () => {
	let dir = "";
	let writes = 0;
	let hashes: string[] = [];
	beforeEach(() => {
		resetUsbNetMarkers();
		dir = mkdtempSync(join(tmpdir(), "shared-serial-"));
		setConfigFilePath(join(dir, "config.json"));
		getConfig().usb_serial_shared = undefined;
		writes = 0;
		hashes = [];
	});
	afterEach(() => {
		resetUsbNetMarkers();
		getConfig().usb_serial_shared = undefined;
		setConfigFilePath("config.json");
		rmSync(dir, { recursive: true });
	});

	function pair(serial = "SHARED_SERIAL_TOKEN"): RouterCellularScanDeps {
		return {
			...constructedTwinDeps(constructedTwins.map((d) => ({ ...d, serial }))),
			sharedSerials: {
				load: () => hashes,
				save: (next) => {
					hashes = next;
					writes += 1;
				},
			},
		};
	}
	const names = constructedTwins.map((d) => d.ifname);

	it("counts distinct USB parents, ignores PID differences, and keeps VIDs separate", async () => {
		const first = constructedTwins[0];
		const second = constructedTwins[1];
		if (!first || !second) throw new Error("missing twins");
		for (const [devices, duplicate] of [
			[
				[
					{ ...first },
					{
						...first,
						ifname: "wwan-extra",
						readlink: first.readlink.replace(/:1\.0$/, ":1.4"),
						udevadm: {
							...first.udevadm,
							ID_PATH: first.udevadm.ID_PATH.replace(/:1\.0$/, ":1.4"),
						},
					},
				],
				false,
			],
			[[{ ...first }, { ...second, idProduct: "9999" }], true],
			[[{ ...first }, { ...second, idVendor: "05c6" }], false],
		] as const) {
			resetUsbNetMarkers();
			const deps = constructedTwinDeps(
				devices.map((d) => ({ ...d, serial: "SHARED_SERIAL_TOKEN" })),
			);
			await refreshUsbNetMarkers(
				devices.map((d) => d.ifname),
				deps,
			);
			for (const device of devices) {
				expect(resolveModemPhysicalIdentity(device.ifname).anchor).toBe(
					duplicate ? "id-path" : "usb-serial",
				);
				expect(getUsbPhysicalDescriptor(device.ifname)?.serial).toBe(
					duplicate ? undefined : "SHARED_SERIAL_TOKEN",
				);
			}
		}
	});

	it("keeps a singleton on its port after pair detection and config reload", async () => {
		const deps = pair();
		await refreshUsbNetMarkers(names.slice(0, 1), deps);
		expect(resolveModemPhysicalIdentity(names[0] ?? "").anchor).toBe(
			"usb-serial",
		);
		expect(writes).toBe(0);
		await refreshUsbNetMarkers(names, deps);
		const id = resolveModemPhysicalIdentity(names[0] ?? "").linkId;
		expect(resolveModemPhysicalIdentity(names[0] ?? "").anchor).toBe("id-path");
		const digest = new Bun.CryptoHasher("sha256")
			.update("413c:SHARED_SERIAL_TOKEN")
			.digest("hex");
		expect(hashes).toEqual([digest]);
		expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
		expect(writes).toBe(1);
		await refreshUsbNetMarkers(names, deps);
		expect(writes).toBe(1);
		resetUsbNetMarkers();
		await refreshUsbNetMarkers(names.slice(0, 1), deps);
		expect(resolveModemPhysicalIdentity(names[0] ?? "").linkId).toBe(id);
		expect(writes).toBe(1);
	});

	it("persists only hashes through the real config schema and reload path", async () => {
		writeFileSync(join(dir, "config.json"), "{}");
		await loadConfig();
		const deps = pair("PERSISTED_SERIAL_TOKEN");
		deps.sharedSerials = {
			load: () => getConfig().usb_serial_shared ?? [],
			save: (next) => {
				getConfig().usb_serial_shared = next;
				saveConfig();
				writes += 1;
			},
		};
		await refreshUsbNetMarkers(names, deps);
		const data = readFileSync(join(dir, "config.json"), "utf8");
		expect(data).not.toContain("PERSISTED_SERIAL_TOKEN");
		const parsed = runtimeConfigSchema.parse(JSON.parse(data));
		expect(parsed.usb_serial_shared).toEqual([
			new Bun.CryptoHasher("sha256")
				.update("413c:PERSISTED_SERIAL_TOKEN")
				.digest("hex"),
		]);
		resetUsbNetMarkers();
		getConfig().usb_serial_shared = undefined;
		await loadConfig();
		await refreshUsbNetMarkers(names.slice(0, 1), deps);
		expect(resolveModemPhysicalIdentity(names[0] ?? "").anchor).toBe("id-path");
		expect(writes).toBe(1);
	});

	it("keeps the newest 64 hashes and writes only on a new shared serial", async () => {
		hashes = Array.from({ length: 64 }, (_, i) =>
			new Bun.CryptoHasher("sha256").update(`OLD_TOKEN_${i}`).digest("hex"),
		);
		const oldest = hashes[0];
		const deps = pair();
		await refreshUsbNetMarkers(names, deps);
		expect(hashes).toHaveLength(64);
		expect(hashes).not.toContain(oldest);
		expect(hashes.at(-1)).toBe(
			new Bun.CryptoHasher("sha256")
				.update("413c:SHARED_SERIAL_TOKEN")
				.digest("hex"),
		);
		expect(writes).toBe(1);
	});

	it("does not persist or remember duplicates from a superseded scan", async () => {
		const gate = makeGate();
		const old = pair();
		const resolveLink = old.resolveLink;
		old.resolveLink = async (path) => {
			await gate.passed;
			return resolveLink(path);
		};
		const pending = refreshUsbNetMarkers(names, old);
		const newer = pair();
		await refreshUsbNetMarkers(names.slice(0, 1), newer);
		gate.open();
		expect(await pending).toBe(false);
		expect(hashes).toEqual([]);
		expect(writes).toBe(0);
		resetUsbNetMarkers();
		await refreshUsbNetMarkers(names.slice(0, 1), newer);
		expect(resolveModemPhysicalIdentity(names[0] ?? "").anchor).toBe(
			"usb-serial",
		);
	});

	it("validates hash-only config with absent meaning empty", () => {
		expect(runtimeConfigSchema.parse({}).usb_serial_shared).toBeUndefined();
		expect(
			runtimeConfigSchema.safeParse({ usb_serial_shared: ["RAW_SERIAL_TOKEN"] })
				.success,
		).toBe(false);
	});
});
