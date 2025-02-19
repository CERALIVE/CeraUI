/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

import { config } from "../config.ts";
import { updateButtonEnabledDisabled } from "../streaming/streaming.ts";
import { removeNotification, showNotification } from "../ui/notifications.ts";
import { genOptionList } from "../ui/options-list.ts";

type Preset = { name: string; disabled?: boolean };

type Relays = {
	servers: {
		[key: string]: { name: string; disabled?: boolean; default?: boolean };
	};
	accounts: { [key: string]: { name: string } };
};

/* Remote relays config */
let isValidRelaySelection = true;

export function getIsValidRelaySelection() {
	return isValidRelaySelection;
}

function updateRelaySettings() {
	if (String($("#relayServer").val()) === "manual") {
		$(".remote-relay-account").addClass("d-none");
		$(".manual-relay-addr, .manual-streamid").removeClass("d-none");
		isValidRelaySelection = true;
	} else {
		$(".manual-relay-addr").addClass("d-none");
		$(".remote-relay-account").removeClass("d-none");
		if (String($("#relayAccount").val()) === "manual") {
			$(".manual-streamid").removeClass("d-none");
		} else {
			$(".manual-streamid").addClass("d-none");
		}
		isValidRelaySelection = $("#relayAccount").val() !== null;
	}

	if (isValidRelaySelection) {
		removeNotification("relay_account_unavailable");
	} else {
		showNotification({
			name: "relay_account_unavailable",
			type: "error",
			msg:
				"Your selected relay server account is no longer available. " +
				"Please select a different one to start the stream.",
		});
	}
	updateButtonEnabledDisabled();
}

let relays: Relays | undefined;
export function updateRelays(r: Partial<Relays> | null) {
	if (r?.servers && r.accounts) {
		relays = r as Relays;
	}

	const preset: Record<string, Preset> = {
		manual: { name: "Manual configuration" },
	};

	let selectedServer = config.relay_server;
	if (!relays || config.srtla_addr || config.srtla_port) {
		selectedServer = "manual";
	} else if (!config.relay_server || !relays.servers[config.relay_server]) {
		for (const s in relays.servers) {
			if (relays.servers[s].default) {
				selectedServer = s;
			}
		}
	}
	const serverList = genOptionList(
		[relays ? relays.servers : {}, preset],
		selectedServer,
	);
	$("#relayServer").html(serverList as unknown as string);

	let selectedAccount = config.relay_account;
	if (!relays || config.srt_streamid !== undefined) {
		selectedAccount = "manual";
	} else if (config.relay_account) {
		if (!relays.accounts[config.relay_account]) {
			preset.unavailable = { name: "No longer available", disabled: true };
			selectedAccount = "unavailable";
		}
	}
	const accountList = genOptionList(
		[relays ? relays.accounts : {}, preset],
		selectedAccount,
	);
	$("#relayAccount").html(accountList as unknown as string);

	updateRelaySettings();
}

export function initRemoteRelays() {
	$("#relayServer, #relayAccount").on("change", () => {
		updateRelaySettings();
	});
}
