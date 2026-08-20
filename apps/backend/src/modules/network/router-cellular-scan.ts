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
 * Reading the USB descriptors behind each enumerated network interface.
 *
 * This is the effectful half of the router-cellular classification; the rule
 * itself is the pure `usb-net-classifier.ts`. The split is the same one
 * `policy-route-check.ts` uses — an async read feeds a cache, and the
 * synchronous netif payload assembly reads that cache — because
 * `netIfBuildMsg()` cannot await anything.
 *
 * WHY SYSFS AND NOT `udevadm`. Everything the CLASSIFICATION needs is a handful
 * of small files under `/sys/class/net/<if>/device/..`: `idVendor`, `idProduct`,
 * the string descriptors, and one `bInterfaceClass`/`SubClass`/`Protocol` triple
 * per interface of the physical device. No process is spawned at all, so this
 * costs nothing on the 5 s netif cadence and cannot fail the way a spawn can. It
 * is also the SAME source the bench inventory sweep reads, so a fixture captured
 * from the board is byte-comparable with what this parses.
 *
 * The NAME resolution needs one thing sysfs does not hold — the usb.ids model
 * for a dongle that publishes a device-class string instead of a model — so
 * udev's own database file for the parent USB device is READ (never spawned),
 * see `readUdevDatabaseNames`.
 *
 * WHAT IS DELIBERATELY NOT READ: the interface NAME. It is used as a map key
 * and as the path segment that finds the device, and never as an input to any
 * decision — see `usb-net-classifier.ts`'s naming rule.
 *
 * FAILURE POSTURE: total. A missing `device` symlink (a PCIe NIC, loopback), an
 * unreadable attribute, a device with no `idVendor` (not USB) — each yields NO
 * marker for that interface and never throws into the netif loop.
 */

import { readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { logger } from "../../helpers/logger.ts";
import {
	classifyUsbNetDevice,
	modelLabel,
	type UsbInterfaceDescriptor,
	type UsbNetClass,
	type UsbNetClassification,
	type UsbNetDevice,
	unitDiscriminator,
	vendorLabel,
	vidPidOf,
} from "./usb-net-classifier.ts";

/**
 * The subset of a classified router-mode cellular dongle that reaches the
 * `netif` wire projection.
 */
export type RouterCellularMarker = {
	vendor: string;
	model: string;
	/** Lowercase `xxxx:xxxx` — the SKU discriminator, shown to the operator. */
	vid_pid: string;
	kind: "router-cellular";
	/**
	 * Another classified router-cellular device on this host reports the SAME
	 * `vid_pid`. Same model ⇒ same factory LAN subnet and same factory DHCP
	 * offer, so the two hand the host colliding addresses — proven on this bench
	 * by two physically distinct Huawei HiLink units both leasing 192.168.8.100.
	 * This is a MEASURED fact about the devices present, never a guess about the
	 * model, so it is `false` for a lone dongle.
	 */
	duplicate_model: boolean;
	/**
	 * The device's own serial, present ONLY while `duplicate_model` is true.
	 *
	 * It is the one fact that separates two units of one SKU, and it is withheld
	 * otherwise because a lone device needs no discriminator and a serial beside
	 * its name is noise. A device that publishes none simply has no entry here.
	 */
	serial?: string;
};

export type RouterCellularScanDeps = {
	/** Root the sysfs paths are resolved under. `/` in production. */
	sysfsRoot: string;
	/** Directory udev persists its device database in. */
	udevDataRoot: string;
	listDir: (path: string) => Promise<string[]>;
	readAttr: (path: string) => Promise<string | undefined>;
	/** Resolve a symlink to its target path; used for `device` and `driver`. */
	resolveLink: (path: string) => Promise<string | undefined>;
	/** Read the basename a symlink points at (the bound driver's name). */
	readLinkName: (path: string) => Promise<string | undefined>;
};

async function defaultListDir(path: string): Promise<string[]> {
	return await readdir(path);
}

async function defaultReadAttr(path: string): Promise<string | undefined> {
	try {
		return (await Bun.file(path).text()).trim();
	} catch {
		return undefined;
	}
}

async function defaultResolveLink(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function defaultReadLinkName(path: string): Promise<string | undefined> {
	try {
		return basename(await readlink(path));
	} catch {
		return undefined;
	}
}

export const defaultRouterCellularScanDeps: RouterCellularScanDeps = {
	sysfsRoot: "/",
	udevDataRoot: "/run/udev/data",
	listDir: defaultListDir,
	readAttr: defaultReadAttr,
	resolveLink: defaultResolveLink,
	readLinkName: defaultReadLinkName,
};

/** Parse a sysfs hex-byte attribute (`"0a"`, `"ff"`); `undefined` when unusable. */
function hexByte(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const digits = /^[0-9a-fA-F]{1,2}$/.exec(raw.trim())?.[0];
	if (digits === undefined) return undefined;
	const value = Number.parseInt(digits, 16);
	return Number.isNaN(value) ? undefined : value;
}

/** Parse a sysfs 4-hex id (`idVendor`/`idProduct`); `undefined` when unusable. */
function hexId(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const id = /^[0-9a-fA-F]{4}$/.exec(raw.trim())?.[0];
	return id?.toLowerCase();
}

// A USB interface directory under a device: `<busid>:<config>.<interface>`,
// e.g. `1-1.3.2:1.0`. Matching the SHAPE keeps unrelated sysfs entries
// (`power/`, `ep_00`, `driver`) out without an allowlist of names to maintain.
const USB_INTERFACE_DIR_RE = /^[\d-]+[\d.]*:\d+\.\d+$/;

async function readInterfaceDescriptor(
	dir: string,
	deps: RouterCellularScanDeps,
): Promise<UsbInterfaceDescriptor | undefined> {
	const [cls, sub, proto] = await Promise.all([
		deps.readAttr(join(dir, "bInterfaceClass")),
		deps.readAttr(join(dir, "bInterfaceSubClass")),
		deps.readAttr(join(dir, "bInterfaceProtocol")),
	]);
	const interfaceClass = hexByte(cls);
	const interfaceSubClass = hexByte(sub);
	const interfaceProtocol = hexByte(proto);
	if (
		interfaceClass === undefined ||
		interfaceSubClass === undefined ||
		interfaceProtocol === undefined
	) {
		// An interface whose descriptors cannot be read is SKIPPED, never
		// defaulted to zeros — 0x00/0x00/0x00 is a real (per-interface class)
		// value the classifier would then reason about.
		return undefined;
	}
	const driver = await deps.readLinkName(join(dir, "driver"));
	return {
		interfaceClass,
		interfaceSubClass,
		interfaceProtocol,
		...(driver !== undefined ? { driver } : {}),
	};
}

/**
 * The udev database entry for a USB device is keyed by its CHARACTER-DEVICE
 * number, not by its bus id: `/run/udev/data/c<major>:<minor>`. usbfs is major
 * 189 and packs 128 devices per bus, which is what this arithmetic undoes.
 */
const USBFS_MAJOR = 189;
const USBFS_DEVICES_PER_BUS = 128;

function decimal(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw.trim())) return undefined;
	const value = Number.parseInt(raw.trim(), 10);
	return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The hwdb-resolved vendor/model names udev recorded for a USB device.
 *
 * WHY THE DEVICE AND NOT THE NETDEV. On this bench the second Huawei HiLink's
 * netdev carries NO udev properties at all — its db entry is a bare
 * `E:ID_RENAMING=1`, because two physically distinct units ship ONE factory MAC
 * (`0c:5b:8f:27:9a:64`), so systemd's `73-usb-net-by-mac.link` tried to rename
 * BOTH to `enx0c5b8f279a64`, the second rename failed `-EEXIST`, and udev never
 * committed the rest of that device's properties. Its parent USB device is a
 * separate udev device whose entry is complete, so reading THERE is what makes
 * the name resolution immune to the collision rather than a victim of it.
 *
 * Parsed rather than spawned (`udevadm info`) to keep this module's zero-spawn
 * posture on the 5 s netif cadence: the entry is a small line-oriented text file
 * whose property lines are prefixed `E:`.
 */
async function readUdevDeviceProperties(
	deviceDir: string,
	deps: RouterCellularScanDeps,
): Promise<{
	databaseVendor?: string;
	databaseModel?: string;
	idPath?: string;
}> {
	const [busRaw, devRaw] = await Promise.all([
		deps.readAttr(join(deviceDir, "busnum")),
		deps.readAttr(join(deviceDir, "devnum")),
	]);
	const busnum = decimal(busRaw);
	const devnum = decimal(devRaw);
	if (
		busnum === undefined ||
		devnum === undefined ||
		busnum < 1 ||
		devnum < 1
	) {
		return {};
	}

	const minor = (busnum - 1) * USBFS_DEVICES_PER_BUS + (devnum - 1);
	const raw = await deps.readAttr(
		join(deps.udevDataRoot, `c${USBFS_MAJOR}:${minor}`),
	);
	if (raw === undefined) return {};

	let databaseVendor: string | undefined;
	let databaseModel: string | undefined;
	let idPath: string | undefined;
	for (const line of raw.split("\n")) {
		if (!line.startsWith("E:")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(2, eq);
		const value = line.slice(eq + 1).trim();
		if (value === "") continue;
		if (key === "ID_VENDOR_FROM_DATABASE") databaseVendor = value;
		else if (key === "ID_MODEL_FROM_DATABASE") databaseModel = value;
		else if (key === "ID_PATH") idPath = value;
	}
	return {
		...(databaseVendor !== undefined ? { databaseVendor } : {}),
		...(databaseModel !== undefined ? { databaseModel } : {}),
		...(idPath !== undefined ? { idPath } : {}),
	};
}

/**
 * Resolve the USB device behind one network interface.
 *
 * `/sys/class/net/<if>/device` points at the USB INTERFACE the netdev belongs
 * to; its parent directory is the physical DEVICE, and that is what carries the
 * vendor/product ids and every sibling interface. Reading only the netdev's own
 * interface would miss the mass-storage companion and the AT/QMI ports — i.e.
 * exactly the descriptors the classification turns on.
 */
export async function readUsbNetDevice(
	ifname: string,
	deps: RouterCellularScanDeps = defaultRouterCellularScanDeps,
): Promise<UsbNetDevice | undefined> {
	const netIfaceLink = join(deps.sysfsRoot, "sys/class/net", ifname, "device");
	const ifaceDir = await deps.resolveLink(netIfaceLink);
	if (ifaceDir === undefined) return undefined;

	const deviceDir = dirname(ifaceDir);
	const [vendorRaw, productRaw] = await Promise.all([
		deps.readAttr(join(deviceDir, "idVendor")),
		deps.readAttr(join(deviceDir, "idProduct")),
	]);
	const vendorId = hexId(vendorRaw);
	const productId = hexId(productRaw);
	// No USB ids ⇒ not a USB device (a PCIe NIC, a virtual link). Not a failure.
	if (vendorId === undefined || productId === undefined) return undefined;

	const [
		manufacturer,
		product,
		serialNumber,
		deviceClassRaw,
		entries,
		udevProperties,
	] = await Promise.all([
		deps.readAttr(join(deviceDir, "manufacturer")),
		deps.readAttr(join(deviceDir, "product")),
		deps.readAttr(join(deviceDir, "serial")),
		deps.readAttr(join(deviceDir, "bDeviceClass")),
		deps.listDir(deviceDir).catch(() => [] as string[]),
		readUdevDeviceProperties(deviceDir, deps).catch(() => ({})),
	]);

	const interfaces: UsbInterfaceDescriptor[] = [];
	for (const entry of entries
		.filter((e) => USB_INTERFACE_DIR_RE.test(e))
		.sort()) {
		const descriptor = await readInterfaceDescriptor(
			join(deviceDir, entry),
			deps,
		);
		if (descriptor) interfaces.push(descriptor);
	}

	return {
		vendorId,
		productId,
		bDeviceClass: hexByte(deviceClassRaw) ?? 0,
		...(manufacturer ? { manufacturer } : {}),
		...(product ? { product } : {}),
		...(serialNumber ? { serialNumber } : {}),
		...udevProperties,
		interfaces,
	};
}

/**
 * The subset of a ModemManager-manageable USB device that reaches the wire.
 *
 * This is the SAME device the Cellular section already owns — the classifier
 * answered `mm-managed`, i.e. the device carries a recognized MBIM/QMI/AT
 * control port. The marker exists so the Ethernet section can recognise a net
 * interface as that modem's own data function instead of rendering it as an
 * unexplained second adapter for one physical device.
 */
export type UsbModemNetMarker = {
	vendor: string;
	model: string;
	/** Lowercase `xxxx:xxxx` — the SKU discriminator, shown to the operator. */
	vid_pid: string;
	kind: "modem-net";
};

/**
 * The physical facts this sweep read about a USB network device, for the ONE
 * identity resolver (`modems/physical-identity.ts`).
 *
 * It is produced for EVERY classified USB net device — router-cellular AND
 * mm-managed alike — because the same physical stick answers to different
 * adapters in its two USB compositions, and an identity that only covered one of
 * them would break at exactly the moment it is needed. Nothing here reaches the
 * `netif` wire; the two marker types above are unchanged.
 */
export type UsbPhysicalDescriptor = {
	ifname: string;
	vid: string;
	pid: string;
	vendor: string;
	model: string;
	deviceClass: UsbNetClass;
	serial?: string;
	idPath?: string;
	hwdbVendor?: string;
	hwdbModel?: string;
};

/** Everything one sysfs sweep produces, each map keyed by interface name. */
export type UsbNetMarkerSets = {
	routerCellular: Map<string, RouterCellularMarker>;
	modemNet: Map<string, UsbModemNetMarker>;
	physical: Map<string, UsbPhysicalDescriptor>;
};

/**
 * Classify every supplied interface and return the markers its class earns.
 *
 * ONE sweep answers both questions because both read the same descriptors off
 * the same parent USB device: a control-port-less cellular tether is a
 * `router-cellular` dongle, and a device carrying a recognized control port is
 * `mm-managed` — ModemManager's, and therefore the Cellular section's.
 *
 * `duplicate_model` is resolved ACROSS the result set, after every device has
 * been classified — it is a statement about what is plugged into this host right
 * now, so it cannot be decided one interface at a time.
 */
export async function scanUsbNetMarkers(
	ifnames: readonly string[],
	deps: RouterCellularScanDeps = defaultRouterCellularScanDeps,
): Promise<UsbNetMarkerSets> {
	const found: Array<{ ifname: string; device: UsbNetDevice }> = [];
	const modemNet = new Map<string, UsbModemNetMarker>();
	const physical = new Map<string, UsbPhysicalDescriptor>();

	for (const ifname of ifnames) {
		try {
			const device = await readUsbNetDevice(ifname, deps);
			if (device === undefined) continue;
			const verdict = classifyUsbNetDevice(device);
			physical.set(ifname, physicalDescriptor(ifname, device, verdict));
			if (verdict.deviceClass === "mm-managed") {
				modemNet.set(ifname, {
					vendor: vendorLabel(device),
					model: modelLabel(device),
					vid_pid: vidPidOf(device),
					kind: "modem-net",
				});
				continue;
			}
			if (verdict.deviceClass !== "router-cellular") continue;
			found.push({ ifname, device });
		} catch (err) {
			// One unreadable interface must never cost the others their markers.
			logger.debug("usb-net scan skipped an interface", {
				ifname,
				err,
			});
		}
	}

	const perSku = new Map<string, number>();
	for (const { device } of found) {
		const sku = vidPidOf(device);
		perSku.set(sku, (perSku.get(sku) ?? 0) + 1);
	}

	const routerCellular = new Map<string, RouterCellularMarker>();
	for (const { ifname, device } of found) {
		const sku = vidPidOf(device);
		const duplicate = (perSku.get(sku) ?? 0) > 1;
		const serial = duplicate ? unitDiscriminator(device) : undefined;
		routerCellular.set(ifname, {
			vendor: vendorLabel(device),
			model: modelLabel(device),
			vid_pid: sku,
			kind: "router-cellular",
			duplicate_model: duplicate,
			...(serial !== undefined ? { serial } : {}),
		});
	}
	return { routerCellular, modemNet, physical };
}

/**
 * The identity resolver's view of one device.
 *
 * The serial is carried UNCONDITIONALLY here, unlike the wire marker's
 * `serial` — that one is a twin discriminator withheld from a lone device
 * because a serial beside a name is noise, whereas this one is an identity
 * anchor and a lone device needs it just as much as a twin does.
 */
function physicalDescriptor(
	ifname: string,
	device: UsbNetDevice,
	verdict: UsbNetClassification,
): UsbPhysicalDescriptor {
	return {
		ifname,
		vid: device.vendorId,
		pid: device.productId,
		vendor: vendorLabel(device),
		model: modelLabel(device),
		deviceClass: verdict.deviceClass,
		...(device.serialNumber !== undefined
			? { serial: device.serialNumber }
			: {}),
		...(device.idPath !== undefined ? { idPath: device.idPath } : {}),
		...(device.databaseVendor !== undefined
			? { hwdbVendor: device.databaseVendor }
			: {}),
		...(device.databaseModel !== undefined
			? { hwdbModel: device.databaseModel }
			: {}),
	};
}

/** The router-mode cellular half of {@link scanUsbNetMarkers}. */
export async function scanRouterCellular(
	ifnames: readonly string[],
	deps: RouterCellularScanDeps = defaultRouterCellularScanDeps,
): Promise<Map<string, RouterCellularMarker>> {
	return (await scanUsbNetMarkers(ifnames, deps)).routerCellular;
}

// ─── Cached snapshot consumed by the (synchronous) netif payload assembly ────

let markers: Map<string, RouterCellularMarker> = new Map();
let modemNetMarkers: Map<string, UsbModemNetMarker> = new Map();
let physicalDescriptors: Map<string, UsbPhysicalDescriptor> = new Map();

function snapshotKey(current: UsbNetMarkerSets): string {
	const router = [...current.routerCellular.entries()].map(
		([ifname, m]) =>
			`${ifname}:${m.vid_pid}:${m.duplicate_model}:${m.serial ?? ""}`,
	);
	const modem = [...current.modemNet.entries()].map(
		([ifname, m]) => `${ifname}:${m.vid_pid}:modem-net`,
	);
	return [...router, ...modem].sort().join("|");
}

function cachedSets(): UsbNetMarkerSets {
	return {
		routerCellular: markers,
		modemNet: modemNetMarkers,
		physical: physicalDescriptors,
	};
}

/**
 * Refresh the cached markers from the current interface set.
 *
 * @returns whether the observable state changed, so a caller may rebroadcast on
 *   a real edge rather than every tick. NEVER throws.
 */
export async function refreshUsbNetMarkers(
	ifnames: readonly string[],
	deps: RouterCellularScanDeps = defaultRouterCellularScanDeps,
): Promise<boolean> {
	const before = snapshotKey(cachedSets());
	try {
		const scanned = await scanUsbNetMarkers(ifnames, deps);
		markers = scanned.routerCellular;
		modemNetMarkers = scanned.modemNet;
		physicalDescriptors = scanned.physical;
	} catch (err) {
		logger.debug("usb-net scan degraded", { err });
		return false;
	}
	return snapshotKey(cachedSets()) !== before;
}

/** The marker for an interface, or `undefined` when it is not a router dongle. */
export function getRouterCellularMarker(
	ifname: string,
): RouterCellularMarker | undefined {
	return markers.get(ifname);
}

/** The full cached marker set (read-only). */
export function getRouterCellularMarkers(): ReadonlyMap<
	string,
	RouterCellularMarker
> {
	return markers;
}

/** The marker for an interface that is an MM-managed modem's data function. */
export function getModemNetMarker(
	ifname: string,
): UsbModemNetMarker | undefined {
	return modemNetMarkers.get(ifname);
}

/** The physical facts read for an interface, for the identity resolver. */
export function getUsbPhysicalDescriptor(
	ifname: string,
): UsbPhysicalDescriptor | undefined {
	return physicalDescriptors.get(ifname);
}

/** Drop every cached marker (test isolation). */
export function resetUsbNetMarkers(): void {
	markers = new Map();
	modemNetMarkers = new Map();
	physicalDescriptors = new Map();
}
