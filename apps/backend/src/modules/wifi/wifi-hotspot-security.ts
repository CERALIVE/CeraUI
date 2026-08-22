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
  The hotspot's SECURITY offering, derived exactly as its CHANNEL offering is.

  `regdomain.ts` derives channels by asking the kernel what this radio may
  transmit on and offering back only that; `wifi-hotspot-config.ts` then rejects
  anything absent from the result. This module is the same contract for security
  modes, with one substitution: the evidence is the per-adapter capability read
  (`wifi-capabilities.ts`) rather than the regulatory domain.

  Why the derivation is READ-TIME here and CACHED there: the regdomain probe is
  async and its result has to be folded onto the interface when it lands, while
  `getWifiCapabilitiesForInterface` is already a synchronous getter over a
  self-refreshing cache. Deriving on read therefore removes a second copy that
  could go stale, and both consumers — the wire builder and the acceptance test
  — call the SAME pure function, so an offered value the device would refuse is
  unrepresentable.

  Three Must-NOT-Haves are enforced structurally rather than by convention:

    - NO `wpa2-wpa3-mixed`. It is absent from {@link HOTSPOT_SECURITY}, so no
      derivation can produce it and no mapping can honour it. A transition-mode
      profile has never been brought up on a board against NM 1.42; shipping the
      option before that is exactly the unproven control this codebase refuses.
    - NO 6 GHz, ever. {@link HOTSPOT_BANDS} is the whole set of bands a hotspot
      may report, and `802-11-wireless.band` has no 6 GHz value — so a 6E/Wi-Fi-7
      adapter's sixth-band capability is dropped rather than offered.
    - NO configurable width. {@link offeredHotspotMaxWidth} answers DISPLAY
      truth only; NetworkManager 1.42 publishes no hotspot channel-width
      property, so nothing here maps a width onto an nmcli field.
*/

import type {
	HotspotBandMaxWidth,
	HotspotSecurityId,
	WifiAdapterCapabilities,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

export type { HotspotBandMaxWidth, HotspotSecurityId };

/**
 * The bands a hotspot may be configured on, and therefore the only bands it may
 * report a width for. 6 GHz is deliberately absent — see the module header.
 */
export const HOTSPOT_BANDS = ["2.4", "5"] as const;
export type HotspotBand = (typeof HOTSPOT_BANDS)[number];

type HotspotSecurityEntry = {
	readonly name: string;
	readonly nmKeyMgmt: string;
	/**
	 * SAE mandates protected management frames, so the two fields must move
	 * together — a `sae` profile left on `pmf: disable` is refused by
	 * NetworkManager at activation.
	 */
	readonly nmPmf: string;
	/**
	 * What `nmcli con show` prints back for {@link nmPmf}. NetworkManager accepts
	 * the string alias on write and reports the numeric enum on read, so a
	 * profile check that compares against the written value flags every healthy
	 * hotspot as externally modified.
	 */
	readonly nmPmfObserved: string;
};

export const HOTSPOT_SECURITY = {
	wpa2: {
		name: "WPA2 (Personal)",
		nmKeyMgmt: "wpa-psk",
		nmPmf: "disable",
		nmPmfObserved: "1",
	},
	"wpa3-sae": {
		name: "WPA3 (SAE)",
		nmKeyMgmt: "sae",
		nmPmf: "required",
		nmPmfObserved: "3",
	},
} as const satisfies Record<HotspotSecurityId, HotspotSecurityEntry>;

/**
 * The mode every adapter is offered, and the one an unstated selection resolves
 * to. Keeping it the default is what makes the whole feature additive: an
 * adapter that proves nothing behaves exactly as it did before this module.
 */
export const DEFAULT_HOTSPOT_SECURITY: HotspotSecurityId = "wpa2";

export const isHotspotSecurityName = (
	security: string,
): security is HotspotSecurityId => security in HOTSPOT_SECURITY;

/**
 * The security modes THIS adapter may host, derived from its own capability
 * read.
 *
 * `wpa3Sae` is a tri-state and only `supported` is proof. `unknown` is the
 * answer for every radio whose driver advertises no SAE feature and whose
 * NetworkManager publishes no SAE key — which on NM 1.42.4 is the shipped fleet
 * — so treating it as a yes would offer WPA3 on hardware nobody has shown can
 * host it.
 */
export function offeredHotspotSecurity(
	capabilities: WifiAdapterCapabilities | undefined,
): HotspotSecurityId[] {
	const offered: HotspotSecurityId[] = [DEFAULT_HOTSPOT_SECURITY];
	if (capabilities?.wpa3Sae === "supported") offered.push("wpa3-sae");
	return offered;
}

/**
 * The authoritative acceptance test, mirroring `isChannelOffered`: a security
 * mode is valid iff the adapter's currently-offered set contains it.
 */
export function isSecurityOffered(
	security: string,
	offered: readonly HotspotSecurityId[],
): security is HotspotSecurityId {
	if (!isHotspotSecurityName(security)) return false;
	return offered.includes(security);
}

/**
 * NetworkManager fields for a security selection, or `undefined` when the mode
 * is not in `offered` — an unoffered mode has no mapping BY CONSTRUCTION, which
 * is what stops it reaching `nmcli` even if validation were bypassed.
 */
export function nmSettingsForSecurity(
	security: string,
	offered: readonly HotspotSecurityId[],
): Record<string, string> | undefined {
	if (!isSecurityOffered(security, offered)) return undefined;
	return hotspotSecurityFields(security);
}

/** The nmcli field set for a mode already known to be offered. */
export function hotspotSecurityFields(
	security: HotspotSecurityId,
): Record<string, string> {
	const entry = HOTSPOT_SECURITY[security];
	return {
		"802-11-wireless-security.key-mgmt": entry.nmKeyMgmt,
		"802-11-wireless-security.pmf": entry.nmPmf,
	};
}

/**
 * The mode a profile's `802-11-wireless-security.key-mgmt` names, or `undefined`
 * when it names something this build does not manage — which is a profile
 * modification rather than a mode, and the caller reports it as one.
 */
export function securityFromNM(keyMgmt: string): HotspotSecurityId | undefined {
	for (const security of Object.keys(HOTSPOT_SECURITY) as HotspotSecurityId[]) {
		if (HOTSPOT_SECURITY[security].nmKeyMgmt === keyMgmt) return security;
	}
	return undefined;
}

/** Operator-facing name for a security selection. */
export function hotspotSecurityName(security: string): string | undefined {
	return isHotspotSecurityName(security)
		? HOTSPOT_SECURITY[security].name
		: undefined;
}

/** The offered set as the wire map, mirroring `getWifiChannelMap`. */
export function getHotspotSecurityMap(
	offered: readonly HotspotSecurityId[],
): Record<string, { name: string }> {
	const map: Record<string, { name: string }> = {};
	for (const security of offered) {
		const name = hotspotSecurityName(security);
		if (name !== undefined) {
			map[security] = { name };
		} else {
			logger.info(`Unknown WiFi hotspot security mode ${security}`);
		}
	}
	return map;
}

/**
 * The widest channel the radio advertises, per hotspot-eligible band.
 *
 * DISPLAY ONLY. A band the radio does not carry is OMITTED rather than
 * zero-filled, so an absent entry reads as "not stated" and never as a measured
 * zero; 6 GHz is dropped whatever the adapter reports, because the iteration is
 * over {@link HOTSPOT_BANDS} rather than over the capability's own band list.
 */
export function offeredHotspotMaxWidth(
	capabilities: WifiAdapterCapabilities | undefined,
): HotspotBandMaxWidth {
	const widths: HotspotBandMaxWidth = {};
	if (capabilities === undefined) return widths;

	for (const band of HOTSPOT_BANDS) {
		if (!capabilities.bands.includes(band)) continue;
		const width = capabilities.maxWidthMhz[band];
		if (typeof width === "number" && Number.isFinite(width) && width > 0) {
			widths[band] = width;
		}
	}
	return widths;
}
