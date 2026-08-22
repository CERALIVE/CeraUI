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
  The nmcli half of the WPA3-SAE station join: argv, and nothing else.

  The RULE — which networks need `sae` — is `@ceraui/rpc`
  `capabilities/wifi-station-security.ts`, shared verbatim with the frontend's
  offering so the two cannot disagree. This module only maps its verdict onto
  NetworkManager's vocabulary, exactly as `wifi-hotspot-security.ts` does for
  the AP side.

  WHY A SAE JOIN IS BUILT RATHER THAN CONNECTED
  ---------------------------------------------
  `nmcli device wifi connect <ssid> password <pw>` both CREATES and ACTIVATES a
  profile in one step, and it is what every non-SAE join keeps using. Its
  key-mgmt is chosen by NetworkManager, and there is no argument to state one:
  `device wifi connect` accepts only `name`/`bssid`/`password`/`wep-key-type`/
  `hidden`/`private`. So on an SAE-only AP there is nothing to correct — a
  profile that came out `wpa-psk` has already failed to activate, and setting
  `sae` on it afterwards would be a field write onto a connection the failure
  path is about to delete.

  The SAE join therefore takes the two-step form that CAN state it:
  `connection add … 802-11-wireless-security.key-mgmt sae` then `connection up`.

  SAE MANDATES PMF, SO THE TWO FIELDS MOVE TOGETHER. This is the same landmine
  `hotspotSecurityFields` documents on the AP side: a `sae` profile left on
  `pmf: disable` is refused by NetworkManager at activation. They are written as
  one record here so neither can be added without the other.

  NOTE the deliberate asymmetry with the hotspot table: `nmPmfObserved` has no
  counterpart here. That field exists because `handleHotspotConn` re-READS a
  profile it owns and must not flag it as externally modified; a station profile
  is never re-read for drift, so there is nothing to compare against.
*/

import { requiresSaeKeyMgmt } from "@ceraui/rpc";

import { argMatch, ID_RE } from "../../helpers/run.ts";
import type { SSID } from "./wifi-interfaces.ts";

/**
 * The nmcli key-mgmt/pmf pair for a WPA3-SAE station profile.
 *
 * NetworkManager stores the SAE password in `psk`, the same property WPA2 uses
 * — there is no separate `sae-password` setting — so only these two differ from
 * an ordinary personal profile.
 */
export const SAE_STATION_NM_FIELDS: Readonly<Record<string, string>> = {
	"802-11-wireless-security.key-mgmt": "sae",
	"802-11-wireless-security.pmf": "required",
};

/**
 * The security fields a station profile for this network must carry, or `{}`
 * when NetworkManager's own negotiation is the right answer.
 *
 * Empty for open, WPA2, enterprise AND transition-mode networks: a WPA2/WPA3
 * transition AP accepts a plain WPA2 association, so pinning `sae` there would
 * refuse the leg a SAE-incapable adapter actually uses.
 */
export function stationSecurityFields(
	security: string | undefined,
): Record<string, string> {
	return requiresSaeKeyMgmt(security) ? { ...SAE_STATION_NM_FIELDS } : {};
}

/**
 * How a join reaches NetworkManager.
 *
 * `nm-auto` is the unchanged `device wifi connect` path every pre-WPA3 join
 * took, byte-for-byte. `sae` is the two-step build described in the header.
 */
export type WifiStationJoinPlan =
	| { readonly mode: "nm-auto"; readonly connectArgs: string[] }
	| { readonly mode: "sae"; readonly addArgs: string[] };

export type WifiStationJoinRequest = {
	readonly ssid: SSID;
	readonly ifname: string;
	readonly password?: string | undefined;
	readonly security?: string | undefined;
};

/** Wall-clock cap handed to nmcli for the connecting steps, in seconds. */
export const WIFI_JOIN_TIMEOUT_S = "15";

function nmAutoArgs({ ssid, ifname, password }: WifiStationJoinRequest) {
	const args = [
		"-w",
		WIFI_JOIN_TIMEOUT_S,
		"device",
		"wifi",
		"connect",
		ssid,
		"ifname",
		ifname,
	];
	if (password) {
		args.push("password", password);
	}
	return args;
}

/**
 * Argv for `connection add`.
 *
 * Insertion order is load-bearing: nmcli reads `type` first, and object key
 * order is what the caller iterates. The profile is named after the SSID so a
 * SAE join is indistinguishable from an `nm-auto` one in `nmcli con show` —
 * `wifiUpdateSavedConns` keys on `802-11-wireless.ssid` either way.
 */
function saeAddArgs({ ssid, ifname, password }: WifiStationJoinRequest) {
	const fields: Record<string, string> = {
		type: "wifi",
		ifname,
		"con-name": ssid,
		ssid,
		...SAE_STATION_NM_FIELDS,
	};
	if (password) {
		fields["802-11-wireless-security.psk"] = password;
	}

	const args = ["connection", "add"];
	for (const [field, value] of Object.entries(fields)) {
		args.push(field, value);
	}
	return args;
}

/** Argv for activating a profile this module just built. */
export function saeActivateArgs(uuid: string): string[] {
	return ["-w", WIFI_JOIN_TIMEOUT_S, "conn", "up", argMatch(ID_RE, uuid)];
}

/**
 * Resolve how this join runs.
 *
 * The SAE branch additionally requires a PASSWORD. SAE is always
 * password-authenticated, so a passwordless SAE request is a malformed one, and
 * building a keyless `sae` profile for it would produce a connection that can
 * never activate. It degrades to `nm-auto`, where the existing failure path
 * reports honestly.
 */
export function planWifiStationJoin(
	request: WifiStationJoinRequest,
): WifiStationJoinPlan {
	if (requiresSaeKeyMgmt(request.security) && request.password) {
		return { mode: "sae", addArgs: saeAddArgs(request) };
	}
	return { mode: "nm-auto", connectArgs: nmAutoArgs(request) };
}
