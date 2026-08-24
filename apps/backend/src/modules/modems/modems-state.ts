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

import { getGsmOperatorName } from "./gsm-operators-cache.ts";
import type {
	ModemId,
	NetworkScanResult,
	NetworkType,
	SimLockRequired,
} from "./mmcli.ts";
import type { ModemStatus } from "./modem-registration.ts";
import type { SimPresence } from "./sim-presence.ts";

export type SimLock = {
	required: SimLockRequired;
	remainingAttempts?: number;
};

export type ModemConfig = {
	conn?: string; // e.g. nmUuid
	autoconfig: boolean; // will only apply if `setup.has_gsm_autoconfig` is true
	apn: string;
	username: string;
	password: string;
	roaming: boolean;
	network: string;
};

export type AvailableNetwork = {
	name: string;
	availability?: NetworkScanResult["availability"];
};

export type Modem = {
	ifname: string; // e.g. wwan0
	name: string; // e.g. "QUECTEL Broadband Module - 00000"
	sim_network: string;
	model?: string; // raw mmcli model, e.g. "RM520N-GL" — undefined if mmcli has no data
	manufacturer?: string; // raw mmcli manufacturer, e.g. "Quectel" — undefined if absent
	network_type: {
		supported: Record<string, NetworkType>; // e.g. { '2g': '2g', '3g': '3g', '3g4g': '3g4g', '4g': '4g' }
		active: string | null; // e.g. '3g4g'
	};
	/**
	 * The UNFOLDED `(allowed, preferred)` catalog, as mmcli reported it.
	 *
	 * `network_type.supported` is keyed by the ALLOWED-SET label, so
	 * `mmConvertNetworkTypes` keeps exactly one entry per label and discards every
	 * other `preferred` the modem advertised for it. That fold is correct for the
	 * coarse selector and destroys the one distinction the 5G-preference module
	 * exists to offer — `allowed: 4g,5g; preferred: 5g` and `allowed: 4g,5g;
	 * preferred: 4g` are one label. This is the same payload, unfolded.
	 */
	radio_modes?: {
		supported: readonly NetworkType[];
		current?: NetworkType;
	};
	is_scanning?: true;
	inhibit?: true; // don't bring up automatically
	config?: ModemConfig;
	status?: ModemStatus;
	/**
	 * Whether ModemManager can SEE a card in this modem. Absent means the read
	 * could not answer — never "no SIM"; see `sim-presence.ts`, which owns the
	 * distinction between this and the presence of an NM connection profile.
	 */
	sim_presence?: SimPresence;
	/**
	 * The SIM's own number(s), as mmcli reported them. SENSITIVE — never logged.
	 * Absent means the carrier published none, which is the ordinary case.
	 */
	own_numbers?: Array<string>;
	/**
	 * The SIM's ICCID, from the SIM object rather than the modem's own `-K`
	 * payload — so a status refresh cannot re-read it and it is PRESERVED across
	 * polls (like `config`, its sibling from the same read). A card swap
	 * re-registers the modem, which is what replaces it.
	 */
	iccid?: string;
	sim_lock?: SimLock;
	available_networks?: Record<string, AvailableNetwork>;
	network_scan?: {
		generation: number;
		phase: "scanning" | "completed" | "failed";
		failure?: "timed_out" | "failed";
	};
	removed?: true;
};

const modemsState: Record<ModemId, Modem> = {};

export function getModems() {
	return modemsState;
}

export function getModemIds(): Array<ModemId> {
	return Object.keys(modemsState).map(Number);
}

export function getModem(id: ModemId) {
	return modemsState[id];
}

export function setModem(id: ModemId, modem: Modem) {
	modemsState[id] = modem;
}

export function removeModem(id: ModemId) {
	delete modemsState[id];
}

export function getAvailableNetworksForModem(modem: Modem) {
	if (!modem.config || modem.config.network === "") {
		return modem.available_networks || {};
	}

	const networks = Object.assign({}, modem.available_networks);
	if (!modem.available_networks) {
		networks[modem.config.network] = {
			name:
				getGsmOperatorName(modem.config.network) ||
				`Operator ID ${modem.config.network}`,
		};
	} else if (!modem.available_networks[modem.config.network]) {
		networks[modem.config.network] = {
			name: "Test",
			availability: "unavailable",
		};
	}

	return networks;
}
