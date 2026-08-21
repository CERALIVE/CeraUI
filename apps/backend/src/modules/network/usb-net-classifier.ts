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
 * Classifying a USB network interface from its DEVICE DESCRIPTORS alone.
 *
 * THE NAMING RULE (the whole reason this module exists): an interface NAME is
 * never an input. `enx0c5b8f279a64` and `eth1` are the SAME model of Huawei
 * HiLink dongle on this bench — the second unit only falls back to the legacy
 * `ethN` scheme because both units ship the identical factory MAC, so the
 * predictable-naming scheme cannot give it an `enx*` name. A rule keyed on the
 * prefix would badge one and miss its twin. Nothing below reads a name.
 *
 * RULE D — this is a MIRROR of modem-stack's
 * `control/src/backend/device-classifier.ts`, never an import. That repo builds,
 * tests and releases standalone; a sibling-path import would break both. The
 * descriptor predicates below are re-derived from the same USB-IF class codes
 * and driver names, and are pinned by CeraUI-local fixtures captured from this
 * project's own bench hardware.
 *
 * WHAT IS MIRRORED, AND WHAT IS ADDED. modem-stack answers "can ModemManager
 * drive this device"; its `router-mode` verdict means "an Ethernet tether with
 * no modem control port", which is equally true of a plain USB-to-Ethernet
 * adapter. CeraUI is about to put the word CELLULAR on an operator's screen, so
 * that verdict alone is not enough: this module keeps modem-stack's precedence
 * verbatim and then requires POSITIVE cellular evidence before claiming
 * `router-cellular`. A tether with no such evidence is `wired-ethernet` — an
 * honest "this is a USB network adapter", not a guess.
 *
 * THE HONESTY RULE, inherited verbatim: the classifier NEVER guesses. Every
 * verdict carries a truthful reason, and an ambiguous descriptor set answers
 * `unknown` rather than a confident-sounding wrong class.
 */

/** One USB interface's descriptor bytes plus its bound kernel driver, if any. */
export type UsbInterfaceDescriptor = {
	readonly interfaceClass: number;
	readonly interfaceSubClass: number;
	readonly interfaceProtocol: number;
	/** The bound kernel driver (`qmi_wwan`, `cdc_ether`, `option`, …). */
	readonly driver?: string;
};

/**
 * A USB device behind one network interface, as read from sysfs.
 *
 * NOTE what is absent: there is no `ifname` field. The classifier cannot read a
 * name because it is not given one.
 */
export type UsbNetDevice = {
	/** Lowercase 4-hex vendor id (`idVendor`). */
	readonly vendorId: string;
	/** Lowercase 4-hex product id (`idProduct`). */
	readonly productId: string;
	/** The device-descriptor `bDeviceClass` byte (0 ⇒ class is per-interface). */
	readonly bDeviceClass: number;
	/** USB string descriptor `manufacturer`, when the device publishes one. */
	readonly manufacturer?: string;
	/** USB string descriptor `product`, when the device publishes one. */
	readonly product?: string;
	/**
	 * `ID_VENDOR_FROM_DATABASE` — the USB-IF registered vendor name, resolved by
	 * udev's hwdb from `idVendor`. NOT the device's own claim about itself.
	 */
	readonly databaseVendor?: string;
	/**
	 * `ID_MODEL_FROM_DATABASE` — the usb.ids MODEL name for this exact
	 * `idVendor:idProduct`. This is the only place a real model name exists for
	 * a dongle that publishes a device-class string instead of a model (see
	 * `publishesGenericIdentity`).
	 */
	readonly databaseModel?: string;
	/**
	 * The device's own `serial` string descriptor, when it publishes one.
	 *
	 * It is NEVER an identity the classifier reasons about — it is carried only
	 * so two units of the SAME model can be told apart on screen, which is the
	 * one thing a `vid:pid` cannot do. A device that publishes none (both bench
	 * HiLinks) simply has no discriminator, and none is invented.
	 */
	readonly serialNumber?: string;
	/**
	 * The udev `ID_PATH` of the physical device — its position in the bus tree.
	 *
	 * CARRIED, NEVER READ HERE. No predicate in this module consults it: it is
	 * neither a descriptor nor evidence of a device class. It rides along so the
	 * ONE sysfs sweep that classifies a device can also feed
	 * `modems/physical-identity.ts`, which anchors identity on it. A path is not
	 * a NAME — the naming rule at the top of this file is untouched.
	 */
	readonly idPath?: string;
	/** EVERY interface of the physical device, not only the net one. */
	readonly interfaces: readonly UsbInterfaceDescriptor[];
	/** Raw udev properties, when available (`ID_USB_MODESWITCH`, …). */
	readonly udevProperties?: Readonly<Record<string, string>>;
};

/**
 * The four classes CeraUI distinguishes.
 *
 * `mm-managed` is modem-stack's own token, kept identical so the two repos'
 * vocabularies do not drift. `router-cellular` NARROWS its `router-mode` with
 * the cellular-evidence gate; `wired-ethernet` is the rest of `router-mode`.
 */
export type UsbNetClass =
	| "mm-managed"
	| "router-cellular"
	| "wired-ethernet"
	| "unknown";

export type UsbNetClassification = {
	readonly deviceClass: UsbNetClass;
	/** Always populated. Never a guess — states the evidence that decided it. */
	readonly reason: string;
};

// ── USB-IF class / subclass / protocol codes (mirrored) ─────────────────────
const CLASS_COMM = 0x02; // CDC communications (control interface)
const CLASS_CDC_DATA = 0x0a; // CDC data interface
const CLASS_MASS_STORAGE = 0x08;
const CLASS_WIRELESS = 0xe0; // wireless controller (RNDIS lives here)
const CLASS_VENDOR = 0xff;
const SUB_ACM = 0x02; // abstract control model (AT commands)
const SUB_ECM = 0x06;
const SUB_NCM = 0x0d;
const SUB_MBIM = 0x0e;
const SUB_RNDIS_WIRELESS = 0x01;
const PROTO_VENDOR = 0xff;
const PROTO_RNDIS = 0x03;

const QMI_DRIVERS: ReadonlySet<string> = new Set(["qmi_wwan"]);
const AT_DRIVERS: ReadonlySet<string> = new Set([
	"option",
	"qcserial",
	"cdc_acm",
]);
const ECM_NCM_DRIVERS: ReadonlySet<string> = new Set(["cdc_ether", "cdc_ncm"]);
const RNDIS_DRIVERS: ReadonlySet<string> = new Set(["rndis_host"]);
const STORAGE_DRIVERS: ReadonlySet<string> = new Set(["usb-storage", "uas"]);

/**
 * USB vendor ids that ship cellular modules or cellular router dongles.
 *
 * This table is EVIDENCE, not the decision: it is consulted only after the
 * descriptors have already proven the device is a control-port-less Ethernet
 * tether. A vendor id on its own never classifies anything, so a Huawei
 * keyboard is not a modem and a cellular vendor's plain NIC is not one either.
 *
 * Every entry is a vendor whose cellular hardware CeraLive has seen or targets;
 * the value is the vendor's own name, used only as a display fallback when the
 * device publishes no `manufacturer` string. Adding a vendor is a code change,
 * deliberately — a table that grew itself would be a guess with extra steps.
 */
export const CELLULAR_USB_VENDOR_IDS: ReadonlyMap<string, string> = new Map([
	["05c6", "Qualcomm"], // reference/QDL composites used by many modules
	["0af0", "Option"],
	["1199", "Sierra Wireless"],
	["12d1", "Huawei"], // HiLink + Stick, both personalities
	["1546", "u-blox"],
	["19d2", "ZTE"], // MF79U-class router dongles
	["1bbb", "TCL/Alcatel"],
	["1c9e", "Longcheer"],
	["1e0e", "SIMCom"],
	["2c7c", "Quectel"],
	["2cb7", "Fibocom"],
	["413c", "Dell"], // Dell-branded WWAN modules
]);

function isMbimControl(i: UsbInterfaceDescriptor): boolean {
	return i.interfaceClass === CLASS_COMM && i.interfaceSubClass === SUB_MBIM;
}

function isQmiControl(i: UsbInterfaceDescriptor): boolean {
	return (
		i.interfaceClass === CLASS_VENDOR &&
		i.driver !== undefined &&
		QMI_DRIVERS.has(i.driver)
	);
}

function isAtControl(i: UsbInterfaceDescriptor): boolean {
	// Standard CDC-ACM AT port. Protocol 0xff on 0x02/0x02 is RNDIS, not AT.
	if (
		i.interfaceClass === CLASS_COMM &&
		i.interfaceSubClass === SUB_ACM &&
		i.interfaceProtocol !== PROTO_VENDOR
	) {
		return true;
	}
	// Vendor-specific serial port bound to a known AT driver.
	return (
		i.interfaceClass === CLASS_VENDOR &&
		i.driver !== undefined &&
		AT_DRIVERS.has(i.driver)
	);
}

function isRndis(i: UsbInterfaceDescriptor): boolean {
	if (
		i.interfaceClass === CLASS_WIRELESS &&
		i.interfaceSubClass === SUB_RNDIS_WIRELESS &&
		i.interfaceProtocol === PROTO_RNDIS
	) {
		return true;
	}
	if (
		i.interfaceClass === CLASS_COMM &&
		i.interfaceSubClass === SUB_ACM &&
		i.interfaceProtocol === PROTO_VENDOR
	) {
		return true;
	}
	return i.driver !== undefined && RNDIS_DRIVERS.has(i.driver);
}

function isEcmNcmData(i: UsbInterfaceDescriptor): boolean {
	if (
		i.interfaceClass === CLASS_COMM &&
		(i.interfaceSubClass === SUB_ECM || i.interfaceSubClass === SUB_NCM)
	) {
		return true;
	}
	return i.driver !== undefined && ECM_NCM_DRIVERS.has(i.driver);
}

function isMassStorage(i: UsbInterfaceDescriptor): boolean {
	if (i.interfaceClass === CLASS_MASS_STORAGE) return true;
	return i.driver !== undefined && STORAGE_DRIVERS.has(i.driver);
}

function isVendorSpecific(i: UsbInterfaceDescriptor): boolean {
	return i.interfaceClass === CLASS_VENDOR;
}

function controlKind(i: UsbInterfaceDescriptor): string {
	if (isMbimControl(i)) return "MBIM";
	return isQmiControl(i) ? "QMI" : "AT";
}

/** The vendor's own name for a known cellular vendor id, else `undefined`. */
export function cellularVendorName(vendorId: string): string | undefined {
	return CELLULAR_USB_VENDOR_IDS.get(vendorId.toLowerCase());
}

/**
 * The positive cellular evidence a control-port-less tether must show before
 * CeraUI will call it cellular. Returns the evidence phrase, or `undefined`
 * when the device offers none — in which case it is reported as a plain USB
 * network adapter rather than badged on a hunch.
 *
 * TWO independent signals, either sufficient:
 *
 *  1. a KNOWN CELLULAR VENDOR ID. Both bench router dongles are covered by it
 *     (`12d1` Huawei HiLink, `19d2` ZTE MF79U-class).
 *  2. a MASS-STORAGE COMPANION INTERFACE on the same physical device — the
 *     "ZeroCD" installer LUN every router-mode cellular dongle carries and no
 *     plain USB-Ethernet adapter does. Vendor-agnostic, so an unlisted vendor's
 *     dongle is still recognised. A `ID_USB_MODESWITCH` udev property counts as
 *     the same signal where udev supplies one.
 */
export function cellularEvidence(device: UsbNetDevice): string | undefined {
	const vendor = cellularVendorName(device.vendorId);
	if (vendor !== undefined) {
		return `USB vendor ${device.vendorId} is ${vendor}, a cellular-module vendor`;
	}

	const modeswitch = device.udevProperties?.ID_USB_MODESWITCH;
	if (modeswitch !== undefined && modeswitch !== "" && modeswitch !== "0") {
		return "device carries a usb_modeswitch trigger — a mode-switching dongle";
	}

	if (device.interfaces.some(isMassStorage)) {
		return "device also presents a mass-storage installer interface — the ZeroCD personality of a router-mode dongle";
	}

	return undefined;
}

function unknownReason(device: UsbNetDevice, hasStorage: boolean): string {
	if (hasStorage) {
		return "mass-storage interfaces only — no network tether and no modem control port";
	}
	if (device.interfaces.some(isVendorSpecific)) {
		return "vendor-specific interface(s) with no recognized modem driver — cannot confidently classify";
	}
	return "no recognized modem control port or Ethernet tether";
}

/**
 * Classify the USB device behind ONE network interface, from descriptors only.
 *
 * Precedence — the first three steps are modem-stack's, unchanged:
 *   1. a recognized MM control port (MBIM / QMI / AT) ⇒ `mm-managed`; the
 *      Cellular section owns that device, so no Ethernet-row badge is claimed.
 *   2. a network tether with NO control port (ECM / NCM / RNDIS / CDC-data):
 *      2a. WITH positive cellular evidence ⇒ `router-cellular`;
 *      2b. WITHOUT it ⇒ `wired-ethernet` — a USB network adapter, said plainly.
 *   3. anything else ⇒ `unknown`, with an honest reason.
 */
import { modemControlFunction } from "../modem-control-compat.ts";

const packagedClassifyUsbNetDevice = modemControlFunction<
	typeof classifyUsbNetDevice | undefined
>("classifyUsbNetDevice", undefined);

export function classifyUsbNetDevice(
	device: UsbNetDevice,
): UsbNetClassification {
	if (packagedClassifyUsbNetDevice !== undefined) {
		return packagedClassifyUsbNetDevice(device);
	}
	const ifaces = device.interfaces;

	const control = ifaces.find(
		(i) => isMbimControl(i) || isQmiControl(i) || isAtControl(i),
	);
	if (control !== undefined) {
		return {
			deviceClass: "mm-managed",
			reason: `recognized ${controlKind(control)} control interface — ModemManager-manageable`,
		};
	}

	// A CDC data interface (class 0x0a) is the payload half of an ECM/NCM pair;
	// both bench dongles present one beside their 0x02/0x06 control half.
	const tether = ifaces.find(
		(i) => isRndis(i) || isEcmNcmData(i) || i.interfaceClass === CLASS_CDC_DATA,
	);
	if (tether !== undefined) {
		const kind = isRndis(tether) ? "RNDIS" : "ECM/NCM";
		const evidence = cellularEvidence(device);
		if (evidence === undefined) {
			return {
				deviceClass: "wired-ethernet",
				reason: `${kind} Ethernet tether with no modem control port and no cellular evidence — a USB network adapter`,
			};
		}
		return {
			deviceClass: "router-cellular",
			reason: `${kind} Ethernet tether with no modem control port; ${evidence}`,
		};
	}

	const hasStorage =
		ifaces.some(isMassStorage) || device.bDeviceClass === CLASS_MASS_STORAGE;
	return {
		deviceClass: "unknown",
		reason: unknownReason(device, hasStorage),
	};
}

/** `"12d1:14dc"` — the lowercase pair both repos use as a SKU discriminator. */
export function vidPidOf(device: UsbNetDevice): string {
	return `${device.vendorId.toLowerCase()}:${device.productId.toLowerCase()}`;
}

/**
 * Did the device publish ONE string for both its manufacturer and its product?
 *
 * That is a device-class name, not an identity: this bench's Huawei HiLink units
 * publish `HUAWEI_MOBILE` for BOTH descriptors, so neither field names a vendor
 * and neither names a model — the operator saw `HUAWEI_MOBILE` where a model
 * belongs, and both units read identically. It is a MEASURED property of the two
 * strings, never a name pattern or a vendor allowlist, so a device that
 * distinguishes the two (the bench ZTE: `ZTE,Incorporated` / `ZTE Mobile
 * Boardband`) is untouched and keeps its own words, typos included.
 */
export function publishesGenericIdentity(device: UsbNetDevice): boolean {
	const manufacturer = device.manufacturer?.trim();
	const product = device.product?.trim();
	if (!manufacturer || !product) return false;
	return manufacturer.toLowerCase() === product.toLowerCase();
}

/**
 * The operator-facing vendor label.
 *
 * The device's own `manufacturer` string wins, verbatim. The exception is a
 * device whose two descriptors are the same string: it named a class rather than
 * itself, so the curated vid table supplies the vendor. The table is preferred
 * over udev's hwdb name here because hwdb carries the USB-IF REGISTRATION, which
 * for a vendor id can name a business unit rather than the brand an operator
 * reads on the casing (`19d2` registers as `ZTE WCDMA Technologies MSM`).
 *
 * A generic-identity device NEVER falls back to its own published string. That
 * string has already been MEASURED to be a device class, so re-using it as a
 * last resort would print the very word this function exists to replace — the
 * bench `05c6:9024` sticks publish `Android` for both descriptors and reached
 * the operator as `Android`. The vendor id is the honest floor instead.
 */
export function vendorLabel(device: UsbNetDevice): string {
	const published = device.manufacturer?.trim();
	if (published && !publishesGenericIdentity(device)) return published;
	return (
		cellularVendorName(device.vendorId) ??
		device.databaseVendor?.trim() ??
		device.vendorId
	);
}

/**
 * The operator-facing model label.
 *
 * The device's own `product` string wins unless it is the generic self-duplicate
 * above, in which case udev's hwdb model for this exact `vid:pid` is the only
 * real model name available (`12d1:14dc` → `E3372 LTE/UMTS/GSM HiLink
 * Modem/Networkcard`). With neither, the bare PID is shown — it is the only
 * per-SKU fact left, and it is TRUE, which the re-published class name was not.
 */
export function modelLabel(device: UsbNetDevice): string {
	const published = device.product?.trim();
	if (published && !publishesGenericIdentity(device)) return published;
	return device.databaseModel?.trim() ?? device.productId;
}

/**
 * A trimmed serial that actually discriminates one unit from another.
 *
 * A device that repeats a string descriptor as its serial (or publishes an
 * empty one) has told us nothing, so it gets no discriminator rather than a
 * duplicate of the name it already carries.
 */
export function unitDiscriminator(device: UsbNetDevice): string | undefined {
	const serial = device.serialNumber?.trim();
	if (!serial) return undefined;
	const folded = serial.toLowerCase();
	if (folded === device.manufacturer?.trim().toLowerCase()) return undefined;
	if (folded === device.product?.trim().toLowerCase()) return undefined;
	return serial;
}
