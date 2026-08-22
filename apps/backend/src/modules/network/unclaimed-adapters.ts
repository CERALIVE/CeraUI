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
 * "The adapter is there; nothing is driving it."
 *
 * A wireless or Bluetooth adapter that ENUMERATES but has no kernel driver bound
 * produces NO network interface, NO wiphy, and NO modem — so every other surface
 * in this repo is structurally blind to it and the operator sees an empty
 * Wi-Fi/Bluetooth section that is indistinguishable from "nothing is plugged in".
 * That silence is the defect this module removes: the device is on the bus and it
 * publishes its own identity, so the honest answer is to SAY so.
 *
 * SCOPE, and its one documented blind spot. This reads sysfs, so it can only
 * report devices the kernel ENUMERATED. A PCIe function that never comes up at
 * all — no link training, no config-space probe, the Orange Pi's current state —
 * is invisible to sysfs and therefore invisible here. That is expected and
 * documented, not a bug: claiming a device sysfs never listed would be inventing
 * hardware. This band covers the enumerated-but-driverless case only.
 *
 * TWO BUSES, TWO DIFFERENT QUESTIONS.
 *
 *   PCI  — a driver binds the FUNCTION, so `/sys/bus/pci/devices/<addr>/driver`
 *          answers directly. The device's own `class` attribute names what it is:
 *          `0x0280` (network controller / other — where Wi-Fi parts live) and
 *          `0x0d11` (wireless controller / Bluetooth).
 *
 *   USB  — a class driver binds the INTERFACE, never the parent device. `btusb`
 *          attaches to `…:1.0`, so asking the PARENT for a `driver` symlink
 *          answers `usb` (the bus driver) on every device, bound or not, and a
 *          probe keyed on it would report EVERY Bluetooth controller on the board
 *          as driverless. So the interface nodes are inspected instead
 *          (`/sys/bus/usb/devices/*:*.*`) and the verdicts are COALESCED to the
 *          parent: a parent with ANY bound wireless/BT class interface is
 *          CLAIMED and is not reported, and a parent whose wireless/BT
 *          interfaces are ALL unbound is reported ONCE, keyed on the parent's own
 *          `idVendor`/`idProduct`.
 *
 *          Its blind spot is the mirror of the PCIe one, and is equally
 *          deliberate: only a device that DECLARES the Wireless Controller class
 *          (0xE0) is in scope. A dongle presenting a vendor-specific interface
 *          (0xFF) is indistinguishable from every other unbound vendor-specific
 *          device on the bus, so reporting it would mean claiming a kind the
 *          descriptors never stated.
 *
 * IT NEVER GATES ANYTHING. Nothing here feeds bonding, streaming admission, or a
 * control's enabled state. It publishes one additive wire field that an
 * informational band renders, and that is its whole surface.
 *
 * FAILURE POSTURE: total. An absent `/sys/bus/pci/devices`, an unreadable
 * attribute, a device with no ids — each yields NO row and never throws into the
 * caller's loop. Nothing is spawned, so this costs no process on any cadence.
 */

import { readdir, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
	UnclaimedAdapter,
	UnclaimedAdapterKind,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";

export type UnclaimedAdapterScanDeps = {
	/** Root the sysfs paths are resolved under. `/` in production. */
	sysfsRoot: string;
	listDir: (path: string) => Promise<string[]>;
	readAttr: (path: string) => Promise<string | undefined>;
	/** The basename a `driver` symlink points at, or `undefined` when unbound. */
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

async function defaultReadLinkName(path: string): Promise<string | undefined> {
	try {
		return basename(await readlink(path));
	} catch {
		return undefined;
	}
}

export const defaultUnclaimedAdapterScanDeps: UnclaimedAdapterScanDeps = {
	sysfsRoot: "/",
	listDir: defaultListDir,
	readAttr: defaultReadAttr,
	readLinkName: defaultReadLinkName,
};

// ─── PCI ────────────────────────────────────────────────────────────────────

/**
 * The two PCI class prefixes this probe speaks for, mapped to the honest kind
 * guess each one earns.
 *
 * sysfs prints the full 24-bit `class base:sub:progif` triple as `0xCCSSPP`, so
 * the operative discriminator is the leading FOUR hex digits. `0280` is
 * "network controller / other", which is where a Wi-Fi part lives (a wired NIC
 * is `0200` and is deliberately NOT covered — an unbound Ethernet controller is
 * a different conversation and this band is about the wireless surfaces that
 * render empty). `0d11` is "wireless controller / Bluetooth".
 *
 * It is a GUESS and is named as one: a class code says what the silicon
 * registered itself as, not what the part actually is.
 */
const PCI_CLASS_KINDS: ReadonlyMap<string, UnclaimedAdapterKind> = new Map([
	["0280", "wifi"],
	["0d11", "bluetooth"],
]);

/** `0x028000` → `0280`; anything that is not a sysfs class value → undefined. */
function pciClassPrefix(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const digits = /^0x([0-9a-fA-F]{6})$/.exec(raw.trim())?.[1];
	return digits?.slice(0, 4).toLowerCase();
}

/** `0x14c3` → `14c3`; a value that is not a 4-hex id → undefined. */
function hexId(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const id = /^(?:0x)?([0-9a-fA-F]{4})$/.exec(raw.trim())?.[1];
	return id?.toLowerCase();
}

async function scanPci(
	deps: UnclaimedAdapterScanDeps,
): Promise<UnclaimedAdapter[]> {
	const root = join(deps.sysfsRoot, "sys/bus/pci/devices");
	const entries = await deps.listDir(root).catch(() => [] as string[]);
	const found: UnclaimedAdapter[] = [];

	for (const address of [...entries].sort()) {
		const dir = join(root, address);
		const kind = PCI_CLASS_KINDS.get(
			pciClassPrefix(await deps.readAttr(join(dir, "class"))) ?? "",
		);
		if (kind === undefined) continue;
		// A bound function is somebody else's problem — it works.
		if ((await deps.readLinkName(join(dir, "driver"))) !== undefined) continue;

		const [vendorRaw, deviceRaw] = await Promise.all([
			deps.readAttr(join(dir, "vendor")),
			deps.readAttr(join(dir, "device")),
		]);
		const vendorId = hexId(vendorRaw);
		const deviceId = hexId(deviceRaw);
		// Without ids there is nothing to NAME the device by, and a row that
		// cannot identify its own subject is noise rather than information.
		if (vendorId === undefined || deviceId === undefined) continue;

		found.push({ bus: "pci", vendorId, deviceId, kind });
	}
	return found;
}

// ─── USB ────────────────────────────────────────────────────────────────────

/**
 * A USB INTERFACE directory: `<busid>:<config>.<interface>`, e.g. `1-1.3:1.0`.
 * Matching the SHAPE is what separates an interface node from its parent device
 * node (`1-1.3`) and from the roots (`usb1`) in the same flat directory.
 */
const USB_INTERFACE_DIR_RE = /^([\d-]+[\d.]*):\d+\.\d+$/;

/** USB-IF class 0xE0 — Wireless Controller. Both Wi-Fi and Bluetooth live here. */
const USB_CLASS_WIRELESS = 0xe0;
/** Subclass 0x01 / protocol 0x01 — the Bluetooth programming interface. */
const USB_SUBCLASS_RF = 0x01;
const USB_PROTOCOL_BLUETOOTH = 0x01;

function hexByte(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const digits = /^[0-9a-fA-F]{1,2}$/.exec(raw.trim())?.[0];
	if (digits === undefined) return undefined;
	const value = Number.parseInt(digits, 16);
	return Number.isNaN(value) ? undefined : value;
}

type UsbParentVerdict = {
	/** ANY wireless/BT interface of this device has a driver bound. */
	claimed: boolean;
	kind: UnclaimedAdapterKind;
};

async function scanUsb(
	deps: UnclaimedAdapterScanDeps,
): Promise<UnclaimedAdapter[]> {
	const root = join(deps.sysfsRoot, "sys/bus/usb/devices");
	const entries = await deps.listDir(root).catch(() => [] as string[]);

	// Keyed on the PARENT bus id, because that is the physical device an
	// operator holds — one Bluetooth controller must not draw one row per
	// interface it happens to expose.
	const perParent = new Map<string, UsbParentVerdict>();

	for (const entry of [...entries].sort()) {
		const parent = USB_INTERFACE_DIR_RE.exec(entry)?.[1];
		if (parent === undefined) continue;

		const dir = join(root, entry);
		const [clsRaw, subRaw, protoRaw] = await Promise.all([
			deps.readAttr(join(dir, "bInterfaceClass")),
			deps.readAttr(join(dir, "bInterfaceSubClass")),
			deps.readAttr(join(dir, "bInterfaceProtocol")),
		]);
		const interfaceClass = hexByte(clsRaw);
		if (interfaceClass !== USB_CLASS_WIRELESS) continue;

		const kind: UnclaimedAdapterKind =
			hexByte(subRaw) === USB_SUBCLASS_RF &&
			hexByte(protoRaw) === USB_PROTOCOL_BLUETOOTH
				? "bluetooth"
				: "wireless";

		// THE COALESCING RULE: a class driver binds the INTERFACE, so one bound
		// interface proves the whole device is being driven.
		const bound = (await deps.readLinkName(join(dir, "driver"))) !== undefined;
		const previous = perParent.get(parent);
		perParent.set(parent, {
			claimed: (previous?.claimed ?? false) || bound,
			// A device presenting both a Bluetooth interface and another wireless
			// one is named by the more specific of the two.
			kind: previous?.kind === "bluetooth" ? "bluetooth" : kind,
		});
	}

	const found: UnclaimedAdapter[] = [];
	for (const [parent, verdict] of [...perParent].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (verdict.claimed) continue;
		const dir = join(root, parent);
		const [vendorRaw, deviceRaw] = await Promise.all([
			deps.readAttr(join(dir, "idVendor")),
			deps.readAttr(join(dir, "idProduct")),
		]);
		const vendorId = hexId(vendorRaw);
		const deviceId = hexId(deviceRaw);
		if (vendorId === undefined || deviceId === undefined) continue;
		found.push({ bus: "usb", vendorId, deviceId, kind: verdict.kind });
	}
	return found;
}

/**
 * Every enumerated wireless/BT adapter this host has NOT bound a driver to.
 *
 * Ordered PCI-then-USB, each half already sorted by its own bus address, so the
 * result is stable across ticks and the change comparison below is meaningful.
 * NEVER throws.
 */
export async function scanUnclaimedAdapters(
	deps: UnclaimedAdapterScanDeps = defaultUnclaimedAdapterScanDeps,
): Promise<UnclaimedAdapter[]> {
	try {
		const [pci, usb] = await Promise.all([scanPci(deps), scanUsb(deps)]);
		return [...pci, ...usb];
	} catch (err) {
		logger.debug("unclaimed-adapter scan degraded", { err });
		return [];
	}
}

// ─── Cached snapshot consumed by the (synchronous) status producers ─────────

/**
 * `undefined` until the first probe completes, and an ARRAY forever after.
 *
 * That distinction is the recoverable-field rule: an omitted wire field means
 * "this device never answered the question" (an older backend, or a boot that
 * has not reached the first probe), while an explicit `[]` is the positive
 * answer "every adapter on this host is driven". Collapsing the two would make a
 * device that cannot probe indistinguishable from a healthy one.
 */
let adapters: UnclaimedAdapter[] | undefined;

function snapshotKey(list: readonly UnclaimedAdapter[]): string {
	return list
		.map((a) => `${a.bus}:${a.vendorId}:${a.deviceId}:${a.kind}`)
		.join("|");
}

/**
 * Re-probe and cache.
 *
 * @returns whether the observable state changed, so a caller may rebroadcast on
 *   a real edge rather than every tick. The FIRST completed probe always counts
 *   as an edge — it is the transition from "never asked" to an answer, which is
 *   exactly what the wire field distinguishes. NEVER throws.
 */
export async function refreshUnclaimedAdapters(
	deps: UnclaimedAdapterScanDeps = defaultUnclaimedAdapterScanDeps,
): Promise<boolean> {
	const scanned = await scanUnclaimedAdapters(deps);
	const changed =
		adapters === undefined || snapshotKey(adapters) !== snapshotKey(scanned);
	adapters = scanned;
	// Logged ONLY on a real edge that found something. A host whose adapters are
	// all driven — every shipping board today — is the steady state, and it must
	// cost nothing in the journal on any cadence.
	if (changed && scanned.length > 0) {
		logger.info("unclaimed wireless/BT adapters detected", {
			adapters: scanned,
		});
	}
	return changed;
}

/** The cached list, or `undefined` before the first probe has completed. */
export function getUnclaimedAdapters(): UnclaimedAdapter[] | undefined {
	return adapters;
}

/** Drop the cached probe result (test isolation). */
export function resetUnclaimedAdapters(): void {
	adapters = undefined;
}
