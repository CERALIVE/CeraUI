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
 * ModemManager enum/bitmask decoding for the D-Bus observation fold.
 *
 * These translate MM's numeric wire values into the SAME vocabulary the mmcli
 * path already puts on the wire — RAT tokens the adapter's `RAT_TO_GENERATION`
 * understands, mmcli's `allowed: 4g, 5g` ⇒ `"5g4g"` mode-label grammar, and
 * mmcli's `sim-pin2`-style lock names. Folding here rather than in the adapter
 * is what keeps a D-Bus row indistinguishable from an mmcli one; see
 * `docs/DBUS-OBSERVATION-CONTRACT.md` §(b).
 *
 * Pure. No I/O, no state, no D-Bus types beyond the decoded numbers.
 */

/** MMModemAccessTechnology bits → the RAT tokens the wire adapter understands. */
const ACCESS_TECH_BITS: ReadonlyArray<readonly [number, string]> = [
	[1 << 1, "gsm"], // GSM
	[1 << 2, "gsm"], // GSM_COMPACT
	[1 << 3, "gsm"], // GPRS
	[1 << 4, "gsm"], // EDGE
	[1 << 5, "umts"], // UMTS
	[1 << 6, "umts"], // HSDPA
	[1 << 7, "umts"], // HSUPA
	[1 << 8, "umts"], // HSPA
	[1 << 9, "umts"], // HSPA_PLUS
	[1 << 14, "lte"], // LTE
	[1 << 15, "5gnr"], // 5GNR
	[1 << 16, "lte"], // LTE_CAT_M
	[1 << 17, "lte"], // LTE_NB_IOT
];

/**
 * Decode `Modem.AccessTechnologies` into the active RAT set.
 *
 * Several MM bits fold onto one token on purpose (HSPA+ is `umts`, LTE-M is
 * `lte`): the wire's generation display is derived from these tokens, and a
 * token the adapter does not know would silently drop the generation to `""`.
 */
export function decodeAccessTechnologies(
	mask: number | undefined,
): Set<string> {
	const rats = new Set<string>();
	if (mask === undefined || mask <= 0) {
		return rats;
	}
	for (const [bit, token] of ACCESS_TECH_BITS) {
		if ((mask & bit) !== 0) {
			rats.add(token);
		}
	}
	return rats;
}

/** MMModemMode bits → mmcli's mode tokens. */
const MODE_BITS: ReadonlyArray<readonly [number, string]> = [
	[1 << 1, "2g"],
	[1 << 2, "3g"],
	[1 << 3, "4g"],
	[1 << 4, "5g"],
];

/**
 * Fold an MMModemMode bitmask into mmcli's own mode LABEL.
 *
 * mmcli builds its label by splitting `allowed: 4g, 5g`, sorting, reversing and
 * joining — `"5g4g"`. Reproducing that grammar exactly is what lets the frontend
 * (which indexes `network_type.supported` by that string) work unchanged across
 * a backend switch. An empty mask yields `undefined`, never `""`.
 */
export function modeMaskToLabel(mask: number | undefined): string | undefined {
	if (mask === undefined || mask <= 0) {
		return undefined;
	}
	const tokens = MODE_BITS.filter(([bit]) => (mask & bit) !== 0).map(
		([, token]) => token,
	);
	if (tokens.length === 0) {
		return undefined;
	}
	return tokens.sort().reverse().join("");
}

/**
 * MMModemState (`Modem.State`, signed) → mmcli's `modem.generic.state` token.
 *
 * Decoded here rather than taken from the `ObservationList` row on purpose: the
 * observer suppresses a list emission when no row FINGERPRINT changed, and the
 * fingerprint ignores signal quality — so a signal-only refresh delivers a tree
 * and no list. Reading state from the tree is what lets every refresh fold.
 */
export function decodeMmState(state: number | undefined): string {
	switch (state) {
		case -1:
			return "failed";
		case 1:
			return "initializing";
		case 2:
			return "locked";
		case 3:
			return "disabled";
		case 4:
			return "disabling";
		case 5:
			return "enabling";
		case 6:
			return "enabled";
		case 7:
			return "searching";
		case 8:
			return "registered";
		case 9:
			return "disconnecting";
		case 10:
			return "connecting";
		case 11:
			return "connected";
		default:
			return "unknown";
	}
}

/** MMModem3gppRegistrationState → the mmcli-compatible registration token. */
export function decodeRegistrationState(state: number | undefined): string {
	switch (state) {
		case 0:
			return "idle";
		case 1:
		case 6: // HOME_SMS_ONLY
		case 7: // HOME_CSFB_NOT_PREFERRED
			return "home";
		case 2:
			return "searching";
		case 3:
			return "denied";
		case 5:
		case 8: // ROAMING_SMS_ONLY
		case 9: // ROAMING_CSFB_NOT_PREFERRED
			return "roaming";
		case 11:
			return "emergency-only";
		default:
			return "unknown";
	}
}

/**
 * MMModemLock → mmcli's lock name.
 *
 * `1` (none) maps to `"none"` rather than to absence: the mmcli path publishes
 * `{required:"none"}` for an unlocked SIM, and absence on this seam means "not
 * observed". `0` (unknown) is genuinely not observed, so it yields `undefined`.
 */
export function decodeUnlockRequired(
	lock: number | undefined,
): string | undefined {
	switch (lock) {
		case 1:
			return "none";
		case 2:
			return "sim-pin";
		case 3:
			return "sim-pin2";
		case 4:
			return "sim-puk";
		case 5:
			return "sim-puk2";
		default:
			return undefined;
	}
}

/** MMSimType (`Sim.SimType`) → the wire `sim_type`. */
export function decodeSimType(
	value: number | undefined,
): "physical" | "esim" | undefined {
	if (value === 1) return "physical";
	if (value === 2) return "esim";
	return undefined;
}

/** MMSimEsimStatus (`Sim.EsimStatus`) → the wire `esim_status`. */
export function decodeEsimStatus(
	value: number | undefined,
): "no-profiles" | "with-profiles" | undefined {
	if (value === 1) return "no-profiles";
	if (value === 2) return "with-profiles";
	return undefined;
}

/**
 * MMModem3gppPacketServiceState (`Modem3gpp.PacketServiceState`) → the mmcli
 * `modem.3gpp.packet-service-state` token.
 *
 * `0` (unknown) yields `undefined`: absence on this seam means "not observed",
 * and a radio that has not said whether it is attached must not be reported as
 * detached — that is a fault claim the device did not make.
 */
export function decodePacketServiceState(
	value: number | undefined,
): string | undefined {
	if (value === 1) return "detached";
	if (value === 2) return "attached";
	return undefined;
}

/**
 * MMNetworkError (`Modem3gpp.NetworkRejection`'s `error` key) → the mmcli
 * `modem.3gpp.network-rejection-error` token.
 *
 * These ARE the tokens the frontend's `REJECTION_REASON_KEYS` table already
 * maps to operator copy, so the vocabulary is fixed by that table rather than
 * chosen here. Values follow `MMNetworkError` in ModemManager's
 * `include/ModemManager-enums.h`, which numbers them by their 3GPP reject cause.
 *
 * An unlisted cause yields `undefined` rather than a made-up token: the whole
 * point of the field is that each value points the operator somewhere specific,
 * and a cause this build cannot name says nothing worth rendering.
 */
export function decodeNetworkRejectionError(
	value: number | undefined,
): string | undefined {
	switch (value) {
		case 2:
			return "imsi-unknown-in-hlr";
		case 3:
			return "illegal-ms";
		case 4:
			return "imsi-unknown-in-vlr";
		case 5:
			return "imei-not-accepted";
		case 6:
			return "illegal-me";
		case 7:
			return "gprs-not-allowed";
		case 8:
			return "gprs-and-non-gprs-not-allowed";
		case 11:
			return "plmn-not-allowed";
		case 12:
			return "location-area-not-allowed";
		case 13:
			return "roaming-not-allowed-in-location-area";
		case 14:
			return "gprs-not-allowed-in-plmn";
		case 15:
			return "no-cells-in-location-area";
		case 17:
			return "network-failure";
		case 22:
			return "congestion";
		default:
			return undefined;
	}
}

/** The trailing integer of an MM object path (`…/Modem/7` ⇒ `7`), else `undefined`. */
export function runtimeIdFromPath(path: string): number | undefined {
	const match = /\/(\d+)$/.exec(path);
	if (match?.[1] === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(match[1], 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}
