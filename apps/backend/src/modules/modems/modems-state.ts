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
import type { ModemId, NetworkScanResult, NetworkType } from "./mmcli.ts";
import type { ModemStatus } from "./modem-update-loop.ts";

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
	name: string; // e.g. "QUECTEL Broadband Module - 00000 | VINAPHONE"
	sim_network: string;
	network_type: {
		supported: Record<string, NetworkType>; // e.g. { '2g': '2g', '3g': '3g', '3g4g': '3g4g', '4g': '4g' }
		active: string | null; // e.g. '3g4g'
	};
	is_scanning?: true;
	inhibit?: true; // don't bring up automatically
	config?: ModemConfig;
	status?: ModemStatus;
	available_networks?: Record<string, AvailableNetwork>;
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
