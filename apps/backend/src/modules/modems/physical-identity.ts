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
  THE CANONICAL PHYSICAL-DEVICE RECORD — one resolver, one id authority.

  Before this module the same physical stick was described by two independent
  resolutions that could not agree: `fromMmcliModem` anchored a device on the
  udev `ID_PATH` behind its ModemManager entry, while `fromRouterCellularView`
  had no anchor at all and keyed on the interface NAME — the one property this
  fleet has already proven unusable (two Huawei HiLink units ship ONE factory
  MAC, so systemd names one `enx0c5b8f279a64` and the other falls back to
  `eth1`, and the two race on every replug).

  This module resolves ONE record per physical device from whatever a caller
  observed, and MINTS the opaque per-link `link_id` from it. It is the single id
  authority: the bind-map writer publishes those ids and the telemetry registry
  consumes them, so both must derive from the same record or an operator's link
  telemetry ends up attributed to the wrong modem.

  ── THE IDENTITY LADDER, AND WHY EACH RUNG IS WHERE IT IS ──────────────────

  Board-measured on `ceralive2`, 2026-08-17 (todo 2), on the real fleet:

    1. `usb-serial` — a Qualcomm dual-mode stick at `1-1.4.1` FLIPPED from
       `05c6:9024` (`rndis_host`, a router-class tether) to `05c6:9091`
       (`qmi_wwan`, an MM-managed modem) under a plain `uhubctl` power cycle,
       keeping USB serial `2b16081` throughout. So VID:PID is PROVEN not to be
       an identity for these units, and the serial is proven to survive the one
       transition that moves a device between adapter classes. Its twin at
       `1-1.4.3` (serial `c6125db3`) is the same class of unit.
    2. `id-path` — the two HiLink twins expose NO usable USB serial at all
       (confirmed by fresh `udevadm`/sysfs reads, not assumed) and share a MAC,
       so the ONLY thing that separates them is WHICH PORT each is plugged
       into. Identity for them is therefore SAME-PORT stability: stable across a
       replug into the same port and across a composition change, and
       DELIBERATELY different when a unit is moved to another port.
    3. `ifname` — the honest floor for a device with neither. It is weak and
       says so (`anchor: "ifname"`); nothing is invented to look stronger.

  There is NO alias table unifying rungs, and that is a decision rather than an
  omission. A port alias pointing at a serial-anchored identity would hand the
  NEXT device plugged into that port the previous unit's identity — a silent
  misattribution far worse than a re-minted id. A device whose serial we could
  not read is a device we cannot claim is the same unit, so it anchors on its
  port instead and says so.

  ── `stable_key` IS NOT `identityKey` ─────────────────────────────────────

  The wire's `stable_key` keeps its existing meaning EXACTLY: the ID_PATH-derived
  key from the ONE shared `deriveModemStableKey` rule (`@ceraui/rpc`). Todo 17's
  consumers correlate on it, the usage-policy store files under it, and the
  projection fixtures lock it — so this module does not re-key it, it only
  supplies it to the adapter that never had one. `identityKey` is the internal
  correlation key that additionally admits the serial rung, and `link_id` is
  derived from THAT.
*/

import { createHash } from "node:crypto";

import type { RouterAdmin } from "@ceraui/rpc/schemas";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";

import {
	isUninformativeIdentity,
	type MmcliHardwareIdentity,
	modemHardwareName,
} from "./modem-identity.ts";

/** Which fact anchors this device's identity — strongest rung that applied. */
export type PhysicalIdentityAnchor = "usb-serial" | "id-path" | "ifname";

/**
 * The ModemManager identity layer.
 *
 * `name` is the row title `modem-registration.ts` already composed through
 * {@link modemHardwareName} — i.e. the existing HIMI firmware-string fallback
 * chain, consumed here rather than replaced. When only the raw mmcli fields are
 * available this module runs that SAME chain, so the naming rule has exactly one
 * implementation.
 */
export interface MmIdentityObservation extends MmcliHardwareIdentity {
	readonly name?: string;
}

/** Everything a caller can observe about one physical device, all optional. */
export interface PhysicalObservation {
	readonly ifname: string;
	/** udev `ID_PATH` of the device (any of its interfaces — it is reduced here). */
	readonly idPath?: string;
	readonly vid?: string;
	readonly pid?: string;
	/** The USB `serial` string descriptor, when the device publishes a usable one. */
	readonly serial?: string;
	/** udev hwdb enrichment (`ID_VENDOR_FROM_DATABASE` / `ID_MODEL_FROM_DATABASE`). */
	readonly hwdbVendor?: string;
	readonly hwdbModel?: string;
	/** The classifier's resolved labels (descriptor strings, hwdb-substituted). */
	readonly descriptorVendor?: string;
	readonly descriptorModel?: string;
	readonly mm?: MmIdentityObservation;
	/** The dongle's own admin-API reading, when one was reachable. */
	readonly routerAdmin?: RouterAdmin;
	/** Twin discriminator — appended to the display name, never an identity input. */
	readonly unitLabel?: string;
}

/** The canonical record every consumer of a physical device reads. */
export interface PhysicalDeviceRecord {
	readonly identityKey: string;
	readonly anchor: PhysicalIdentityAnchor;
	/** Minted here, deterministically. See {@link mintLinkId}. */
	readonly linkId: string;
	/** The ID_PATH-derived wire key, omitted when the device reports no ID_PATH. */
	readonly stableKey?: string;
	readonly ifname: string;
	readonly idPath?: string;
	readonly vid?: string;
	readonly pid?: string;
	readonly serial?: string;
	readonly hwdb?: { readonly vendor?: string; readonly model?: string };
	readonly routerAdmin?: RouterAdmin;
	readonly displayName: string;
}

const LINK_ID_PREFIX = "lnk_";
const LINK_ID_DIGEST_CHARS = 16;

/**
 * Mint the opaque per-link id for an identity key.
 *
 * DERIVATION: `lnk_` + the first 16 hex characters of `sha256(identityKey)`.
 *
 * It is a HASH rather than an incrementing registry counter for three reasons,
 * and all three are requirements the consumers place on it:
 *
 *   - **Stable across reloads with NO persisted state.** A counter would have to
 *     survive a backend restart on disk, and a store that fails to load renumbers
 *     every link — precisely the failure the id exists to prevent.
 *   - **Stable across composition changes.** The input is the identity key, and
 *     the ladder above already makes that survive a 9024⇄9091 flip.
 *   - **It carries no secret.** A USB serial must not ride the wire; hashing it
 *     means the published id reveals nothing about the hardware while remaining
 *     equality-comparable, which is the only operation consumers may perform.
 */
export function mintLinkId(identityKey: string): string {
	const digest = createHash("sha256").update(identityKey).digest("hex");
	return `${LINK_ID_PREFIX}${digest.slice(0, LINK_ID_DIGEST_CHARS)}`;
}

/** A serial that actually anchors: present, non-empty, not a repeated descriptor. */
function usableSerial(observation: PhysicalObservation): string | undefined {
	const serial = observation.serial?.trim();
	return serial ? serial : undefined;
}

/** The identity key and the rung it came from. */
function resolveIdentityKey(
	observation: PhysicalObservation,
	stableKey: string | undefined,
): { identityKey: string; anchor: PhysicalIdentityAnchor } {
	const serial = usableSerial(observation);
	if (serial !== undefined) {
		const vid = observation.vid?.trim().toLowerCase();
		return {
			identityKey: vid ? `usb-serial:${vid}:${serial}` : `usb-serial:${serial}`,
			anchor: "usb-serial",
		};
	}
	if (stableKey !== undefined) {
		return { identityKey: `id-path:${stableKey}`, anchor: "id-path" };
	}
	return { identityKey: `ifname:${observation.ifname}`, anchor: "ifname" };
}

/**
 * The leading word of a vendor string — the brand rather than the registration.
 *
 * usb.ids and the descriptors publish trading names (`ZTE,Incorporated`,
 * `ZTE WCDMA Technologies MSM`), which read as boilerplate beside a model.
 */
function vendorWord(vendor: string): string {
	return vendor.split(/[\s,]+/)[0]?.trim() ?? "";
}

/**
 * The name a router dongle's row is titled with.
 *
 * The dongle's OWN admin API is preferred over the USB descriptor, and that is
 * the entire point: usb.ids answers `E3372 LTE/UMTS/GSM HiLink
 * Modem/Networkcard` — a class description shared by every unit of the model —
 * while the device answers `E3372`, which composes into a name an operator
 * recognises. When the device says nothing, the descriptor's answer still ships
 * rather than a placeholder.
 *
 * The BRAND is composed onto the descriptor answer too, not only onto the admin
 * one. A device that published a class name for both its descriptors has no
 * model of its own, so the classifier falls back to its bare product id — and
 * `9024` alone names nothing, while `Qualcomm 9024` names the silicon vendor
 * that USB-IF actually registered.
 *
 * A `serial` is appended only when the classifier measured a same-SKU twin, and
 * it is the only thing that tells two otherwise identical rows apart.
 */
export function routerCellularDisplayName(
	vendor: string,
	model: string,
	admin: RouterAdmin | undefined,
	serial?: string,
): string {
	const brand = vendorWord(vendor);
	const published = admin?.model?.trim();
	const name = published === undefined || published === "" ? model : published;
	const branded =
		brand === "" || name.toLowerCase().startsWith(brand.toLowerCase())
			? name
			: `${brand} ${name}`;
	const unit = serial?.trim();
	return unit ? `${branded} · ${unit}` : branded;
}

/**
 * Display-name precedence, highest first:
 *
 *   1. the MM identity observation — which IS the existing HIMI fallback chain
 *      (`modemHardwareName`), layered on rather than replaced, so a modem whose
 *      firmware answers `model: 0` keeps the title that rule earned it;
 *   2. the dongle's own admin API, then the descriptor/hwdb labels, composed by
 *      {@link routerCellularDisplayName} (admin ≻ descriptor ≻ product id);
 *   3. `vid:pid`, then the interface name — each true, neither invented.
 */
function resolveDisplayName(observation: PhysicalObservation): string {
	const mm = observation.mm;
	if (mm !== undefined) {
		const composed = mm.name?.trim();
		const composedLabel = composed?.split(" - ", 1)[0]?.trim();
		if (composed && composedLabel && !isUninformativeIdentity(composedLabel)) {
			return composed;
		}
		return modemHardwareName(mm);
	}

	const vendor = observation.descriptorVendor ?? observation.hwdbVendor ?? "";
	const vid = observation.vid?.trim().toLowerCase();
	const pid = observation.pid?.trim().toLowerCase();
	const fallback = vid && pid ? `${vid}:${pid}` : observation.ifname;
	const model = firstNamed(
		observation.descriptorModel,
		observation.hwdbModel,
		fallback,
	);
	return routerCellularDisplayName(
		vendor,
		model,
		observation.routerAdmin,
		observation.unitLabel,
	);
}

/**
 * The first candidate that says anything; the last is the stated floor.
 *
 * Deliberately NOT `isUninformativeIdentity` — that rule judges mmcli's own
 * identity answers, where a bare numeral is measured garbage. Here a bare
 * numeral is the PRODUCT ID (`9024`), which the classifier chose as its honest
 * floor precisely because it is true, so rejecting it would replace a real fact
 * with a worse one.
 */
function firstNamed(...candidates: (string | undefined)[]): string {
	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/** Every record resolved this process, keyed by identity — read by todos 11/12. */
const records = new Map<string, PhysicalDeviceRecord>();

/**
 * Resolve (and remember) the canonical record for one observed device.
 *
 * The result is a pure function of the observation — the store exists so a
 * consumer holding only a `link_id` can find the device again, never to make a
 * later resolution depend on an earlier one.
 */
export function resolvePhysicalDevice(
	observation: PhysicalObservation,
): PhysicalDeviceRecord {
	const stableKey = deriveModemStableKey(observation.idPath);
	const { identityKey, anchor } = resolveIdentityKey(observation, stableKey);
	const serial = usableSerial(observation);
	const hwdb =
		observation.hwdbVendor !== undefined || observation.hwdbModel !== undefined
			? {
					...(observation.hwdbVendor !== undefined
						? { vendor: observation.hwdbVendor }
						: {}),
					...(observation.hwdbModel !== undefined
						? { model: observation.hwdbModel }
						: {}),
				}
			: undefined;

	const record: PhysicalDeviceRecord = {
		identityKey,
		anchor,
		linkId: mintLinkId(identityKey),
		ifname: observation.ifname,
		displayName: resolveDisplayName(observation),
		...(stableKey !== undefined ? { stableKey } : {}),
		...(observation.idPath !== undefined ? { idPath: observation.idPath } : {}),
		...(observation.vid !== undefined ? { vid: observation.vid } : {}),
		...(observation.pid !== undefined ? { pid: observation.pid } : {}),
		...(serial !== undefined ? { serial } : {}),
		...(hwdb !== undefined ? { hwdb } : {}),
		...(observation.routerAdmin !== undefined
			? { routerAdmin: observation.routerAdmin }
			: {}),
	};

	records.set(identityKey, record);
	return record;
}

/** The record behind a minted `link_id`, for the consumers of todos 11 and 12. */
export function getPhysicalDeviceByLinkId(
	linkId: string,
): PhysicalDeviceRecord | undefined {
	for (const record of records.values()) {
		if (record.linkId === linkId) return record;
	}
	return undefined;
}

/** Every record resolved so far (read-only). */
export function listPhysicalDevices(): readonly PhysicalDeviceRecord[] {
	return [...records.values()];
}

/** Drop the store (test isolation). Never call this from production code. */
export function resetPhysicalIdentityRegistry(): void {
	records.clear();
}
