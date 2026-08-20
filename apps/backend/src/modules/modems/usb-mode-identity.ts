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

/**
 * Resolving WHICH physical device a legacy modem id names, matching it against the
 * certified catalog, and confirming its data path came back after a switch.
 *
 * It is split from the dispatch because these are the only pure-READ steps in the
 * transition, and keeping them apart is what makes the TIER-A guarantee — an entry
 * refusal fires ZERO engine calls — provable by inspection as well as by a spy.
 */

import {
	type CanonicalUsbMode,
	type CatalogEntry,
	type CertifiedCatalog,
	createUsbEnumerator,
	detectUsbMode,
	MM_USB_MODES,
	type MmUsbMode,
	type SkuDiscriminator,
	type UsbDeviceSnapshot,
} from "@ceralive/modem-control";
import {
	deriveModemStableKey,
	type UsbCompositionMode,
} from "@ceraui/rpc/schemas";

import { type ModemGenericFacts, mmGetModemGenericFacts } from "./mmcli.ts";
import {
	readModemNmDeviceProp,
	resolveModemNmDevice,
} from "./modem-nm-device.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForIfname } from "./mutation-identity.ts";

/** Everything the dispatch resolved about the physical device behind a modem id. */
export interface ResolvedModemIdentity {
	/** ID_PATH-derived, re-enumeration-stable. The ONLY cross-transition key. */
	readonly stableKey: string;
	/** `vid:pid`, lowercase and colon-separated — the catalog's own form. */
	readonly vidPid: string;
	readonly model: string;
	/**
	 * The FULL modem FIRMWARE revision, as ModemManager reports it. The catalog
	 * certifies a PREFIX of it. Empty when MM could not be read — which matches no
	 * catalog entry, so an unreadable revision is uncertified rather than mis-keyed.
	 */
	readonly firmwareRevision: string;
	/** The composition mode udev currently reports; `undefined` when unrecognised. */
	readonly currentMode: CanonicalUsbMode | undefined;
	/** Physical-topology UID captured BEFORE the switch — survives re-enumeration. */
	readonly physicalUid: string;
	readonly ifname: string;
	/** ModemManager's own `modem.generic.ports` list — the AT port comes from here. */
	readonly ports: readonly string[];
}

/**
 * Match a live device against the certified catalog.
 *
 * The catalog's `firmwarePrefix` certifies a firmware FAMILY, not one build, so
 * it is matched with `startsWith` against the device's FULL revision — a device
 * cannot compute the prefix itself, because the length that separates a family
 * from a build is a per-SKU judgement made by whoever reviewed the evidence
 * bundle. Truncating the revision at some fixed length instead would make every
 * carrier build its own uncertified SKU on one entry, and would silently
 * over-match on another.
 *
 * Returns the matched entry, whose discriminators become the request's `sku` so
 * the transition engine's own catalog re-check resolves to the SAME entry.
 */
export function matchCertifiedEntry(
	catalog: CertifiedCatalog,
	identity: Pick<
		ResolvedModemIdentity,
		"vidPid" | "model" | "firmwareRevision"
	>,
): CatalogEntry | undefined {
	return catalog.entries.find(
		(entry) =>
			entry.vidPid === identity.vidPid &&
			entry.model === identity.model &&
			entry.firmwarePrefix.length > 0 &&
			identity.firmwareRevision.startsWith(entry.firmwarePrefix),
	);
}

/** The discriminator triple, taken from the MATCHED entry so both sides agree. */
export function skuOf(entry: CatalogEntry): SkuDiscriminator {
	return {
		vidPid: entry.vidPid,
		model: entry.model,
		firmwarePrefix: entry.firmwarePrefix,
	};
}

/** `vid:pid` in the catalog's lowercase, colon-separated form. */
export function vidPidOf(device: UsbDeviceSnapshot): string {
	return `${device.vendorId.toLowerCase()}:${device.productId.toLowerCase()}`;
}

/** Whether a wire mode is one a transition may legally move BETWEEN. */
export function isMmTransitionMode(
	mode: UsbCompositionMode,
): mode is MmUsbMode & UsbCompositionMode {
	return (MM_USB_MODES as readonly string[]).includes(mode);
}

/**
 * Resolve the udev device behind a legacy modem id.
 *
 * The modem id is an MM index and the ifname is the bench's known-ambiguous
 * identifier, so BOTH are used here only as the one-instant lookup that finds the
 * physical device — the value this returns and everything downstream correlates on
 * is the `ID_PATH`-derived `stable_key`, which is what survives the switch.
 *
 * THE STABLE KEY COMES FROM udev's NET RECORDS, and the USB snapshot is matched
 * AGAINST it. Matching the enumerator on `device.ifname` — what this did — could
 * never succeed on real hardware: that field is declared on `UsbDeviceSnapshot`
 * and never populated, because the enumerator keeps only `DEVTYPE=usb_device`
 * records and a `usb_device` record carries no `INTERFACE` (board-measured on
 * `ceralive2`: 24 such records, 0 with one). So every capability module gated on
 * this resolver answered `unknown_modem` on every real board. This is the SAME
 * defect `modem-id-path-source.ts` was written to fix for the wire producer's
 * `stable_key` map, and `modemStableKeyForIfname` is that same fixed source —
 * reused rather than re-derived, so there is exactly one correct resolver.
 *
 * The enumerator is still consulted, because the catalog discriminators
 * (`vid:pid`, model, firmware revision, composition mode) exist nowhere else. Its
 * `physicalUid` is the parent `usb_device`'s own `ID_PATH`, which reduces through
 * the shared `deriveModemStableKey` to the SAME key the netdev's interface-level
 * path does — so the two sources agree by construction.
 */
/**
 * Test seam (the `set*Runner` convention) — feeds the enumerator canned
 * `udevadm info --export-db` text so the match above is provable against
 * VERBATIM board output rather than against a hand-built snapshot, which is the
 * fixture shape that let the retired `ifname` match look correct.
 */
let udevDatabaseReader: (() => Promise<string>) | undefined;

export function setUsbUdevDatabaseReaderForTest(
	reader: (() => Promise<string>) | null,
): void {
	udevDatabaseReader = reader ?? undefined;
}

/**
 * Test seam for the OTHER identity source. The firmware revision has no udev
 * record to feed, so it cannot be exercised through the reader above.
 */
let genericFactsReader:
	| ((deviceId: string) => Promise<ModemGenericFacts | undefined>)
	| undefined;

export function setModemGenericFactsReaderForTest(
	reader: ((deviceId: string) => Promise<ModemGenericFacts | undefined>) | null,
): void {
	genericFactsReader = reader ?? undefined;
}

export async function defaultResolveIdentity(
	deviceId: string,
): Promise<ResolvedModemIdentity | undefined> {
	const id = Number(deviceId);
	if (!Number.isInteger(id) || !getModemIds().includes(id)) return undefined;

	const ifname = getModem(id)?.ifname;
	if (ifname === undefined || ifname === "") return undefined;

	// No ID_PATH ⇒ no stable key ⇒ the device cannot be followed across the
	// re-enumeration this transition performs. Refusing beats transitioning a
	// device we would then be unable to recognise.
	const stableKey = modemStableKeyForIfname(ifname);
	if (stableKey === undefined) return undefined;

	// The FIRMWARE revision comes from ModemManager, never from the udev record the
	// enumerator returns: udev's ID_REVISION is the USB bcdDevice, a descriptor
	// constant identical across every firmware build of the module.
	const facts = await (genericFactsReader ?? mmGetModemGenericFacts)(
		String(id),
	);

	const devices = await createUsbEnumerator(
		udevDatabaseReader === undefined
			? {}
			: { readUdevDatabase: udevDatabaseReader },
	).enumerate();
	const device = devices.find(
		(d) => deriveModemStableKey(d.physicalUid) === stableKey,
	);
	if (device?.physicalUid === undefined) return undefined;

	return {
		stableKey,
		vidPid: vidPidOf(device),
		model: device.model ?? "",
		firmwareRevision: facts?.revision ?? "",
		currentMode: detectUsbMode(device),
		physicalUid: device.physicalUid,
		ifname,
		ports: facts?.ports ?? [],
	};
}

const DATA_PATH_TIMEOUT_MS = 90_000;
const DATA_PATH_POLL_MS = 2_000;

/**
 * Poll until the modem's data path is back after a switch.
 *
 * The NM device is RE-RESOLVED on every poll rather than once up front: this
 * runs immediately after a re-enumeration, so NM legitimately does not know the
 * new netdev yet on the first ticks, and a device resolved once would be the
 * pre-switch one. `resolveModemNmDevice` is the SAME resolver
 * {@link defaultResolveConnectionId} uses — a second lookup rule here is how
 * the two halves of one transition would disagree about which device they mean.
 */
export async function confirmModemDataPath(ifname: string): Promise<boolean> {
	const deadline = Date.now() + DATA_PATH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const device = await resolveModemNmDevice(ifname);
		if (device !== undefined) {
			const state =
				(await readModemNmDeviceProp(device, "GENERAL.STATE"))?.[0] ?? "";
			const address =
				(await readModemNmDeviceProp(device, "IP4.ADDRESS"))?.[0] ?? "";
			// NetworkManager's `100 (connected)` is the registered-AND-activated
			// state; an address on top of it is the data path itself, not a claim.
			if (state.startsWith("100") && address !== "") return true;
		}
		await new Promise((resolve) => setTimeout(resolve, DATA_PATH_POLL_MS));
	}
	return false;
}

/**
 * The NM connection the transition quiesces and re-activates.
 *
 * `ifname` is the modem's NETDEV, which for an MM-managed modem is NOT an NM
 * device — see `modem-nm-device.ts` for the board measurement and for why
 * asking NM about it directly is what produced BLOCKER B7's bogus
 * `identity_unresolved`.
 */
export async function defaultResolveConnectionId(
	ifname: string,
): Promise<string | undefined> {
	const device = await resolveModemNmDevice(ifname);
	if (device === undefined) return undefined;
	const values = await readModemNmDeviceProp(device, "GENERAL.CON-UUID");
	const uuid = values?.[0]?.trim();
	return uuid !== undefined && uuid !== "" && uuid !== "--" ? uuid : undefined;
}
