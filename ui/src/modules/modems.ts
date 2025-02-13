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

import type {
	ModemsResponseMessageEntry,
	ModemsResponseModemFull,
} from "../../../server/modules/modems.ts";
import type { StatusResponseMessage } from "../../../server/modules/status.ts";
import { genOptionList } from "./options-list.ts";
import { ws } from "./websocket.ts";
import { wifiSignalSymbol } from "./wifi.ts";

/* Modem manager */
function modemFindCardId(deviceId: string) {
	return `modemManager${Number.parseInt(deviceId, 10)}`;
}

type ModemUserConfig = {
	network_type: string | null;
	roaming: boolean;
	network: string;
	autoconfig?: boolean | undefined;
	apn: string;
	username: string;
	password: string;
	device?: string;
};

type ModemState = ModemsResponseModemFull & {
	removed?: boolean;
};

const checkIsFullModemState = (
	state: ModemsResponseMessageEntry,
): state is ModemsResponseModemFull => "name" in state;

let modems: Record<string, ModemState> = {};

export function resetModems() {
	modems = {};
}

function renderDeviceCard(
	cardId: string,
	deviceId: string,
	modemStatusUpdate: ModemsResponseModemFull,
) {
	const html = `
        <div id="${cardId}" class="modem-settings card mb-2">
          <div class="card-header bg-success text-center" type="button" data-toggle="collapse" data-target="#collapse-${cardId}">
            <button class="btn btn-link text-white" type="button" data-toggle="collapse" data-target="#collapse-${cardId}" aria-expanded="false" aria-controls="#collapse-${cardId}">
              Modem: <strong class="device-ifname"></strong><span class="device-name"></span>
            </button>
          </div>

          <div class="collapse" id="collapse-${cardId}">
            <div class="form-group px-3 py-1 mb-2 border-bottom modem-status">
              <span class="signal d-none"></span>
              <span class="status d-none"></span>
              <span class="no-sim text-danger d-none">No SIM card</span>
            </div>
            <div class="card-body pt-0 pb-3 d-none">
              <div class="form-group mb-1">
                <label class="mb-0" for="networkType-${cardId}">Network type</label>
                <select class="network-type-input custom-select" id="networkType-${cardId}"></select>
              </div>
              <div class="form-group mb-1">
                <input type="checkbox" class="roaming-input" id="roaming-${cardId}">
                <label class="mb-0" for="roaming-${cardId}">Allow roaming</label>
              </div>
              <div class="form-group mb-1 network-selection-group">
                <label class="mb-0" for="networkSelection-${cardId}">Network</label>
                <div class="input-group">
                  <select class="network-selection-input custom-select" id="networkSelection-${cardId}"></select>
                  <div class="input-group-append">
                    <button class="btn btn-outline-primary network-scan-button">Scan</button>
                  </div>
                </div>
              </div>
              <div class="form-group mb-1 autoconfig-group d-none">
                <input type="checkbox" class="autoconfig-input" id="autoconfig-${cardId}" disabled>
                <label class="mb-0" for="autoconfig-${cardId}">Automatic APN configuration</label>
              </div>
              <div class="apn-manual-config">
                <div class="form-group mb-1">
                  <label class="mb-0" for="apn-${cardId}">APN</label>
                  <input type="text" class="form-control apn-input" id="apn-${cardId}">
                </div>
                <div class="form-group mb-1">
                  <label class="mb-0" for="username-${cardId}">Username</label>
                  <input type="text" class="form-control username-input" id="username-${cardId}">
                </div>
                <div class="form-group mb-2">
                  <label class="mb-0" for="password-${cardId}">Password</label>
                  <input type="text" class="form-control password-input" id="password-${cardId}">
                </div>
              </div>

              <button class="btn btn-block btn-primary netact save-button" disabled>Save</button>
            </div>
          </div>
        </div>`;

	const deviceCard = $($.parseHTML(html));

	// Set the name
	if (modemStatusUpdate.ifname) {
		deviceCard.find(".device-ifname").text(modemStatusUpdate.ifname);
		deviceCard.find(".device-name").text(` (${modemStatusUpdate.name})`);
	} else {
		deviceCard.find(".device-name").text(modemStatusUpdate.name);
	}

	// Show the status bar, either with the no SIM message or actual signal info
	if (modemStatusUpdate.no_sim) {
		deviceCard.find(".no-sim").removeClass("d-none");
	} else {
		deviceCard.find(".signal, .status, .card-body").removeClass("d-none");
	}

	// Dynamically show and hide network selection depending on the roaming checkbox
	deviceCard
		.find(".roaming-input")
		.on("change", function showHideNetworkSelection() {
			const checkbox = $(this);
			const networkSelection = $(this)
				.parents(".card-body")
				.find(".network-selection-group");
			if (checkbox.prop("checked")) {
				networkSelection.removeClass("d-none");
			} else {
				networkSelection.addClass("d-none");
			}
		});

	// Check if the device supports GSM autoconfiguration
	if (modemStatusUpdate.config?.autoconfig !== undefined) {
		// Dynamically show and hide APN settings depending on the autoconfig checkbox
		const checkbox = deviceCard.find(".autoconfig-input");
		checkbox.on("change", function showHideApnConfig(e) {
			const checkbox = $(e.currentTarget);
			const apnConfigForm = $(e.currentTarget)
				.parents(".card-body")
				.find(".apn-manual-config");
			if (checkbox.prop("checked")) {
				apnConfigForm.addClass("d-none");
			} else {
				apnConfigForm.removeClass("d-none");
			}
		});
		checkbox.prop("disabled", false);
		deviceCard.find(".autoconfig-group").removeClass("d-none");
	}

	const scanButton = deviceCard.find(".network-scan-button");
	scanButton.on("click", () => {
		if (
			confirm(
				"Scanning for networks will temporarily disable the data connection of this modem. Proceed?",
			)
		) {
			scanButton.prop("disabled", true);
			scanButton.text("Scanning...");
			ws?.send(JSON.stringify({ modems: { scan: { device: deviceId } } }));
		}
	});

	const getUserConfig = (
		deviceCard: JQuery<HTMLElement | Node[]>,
	): ModemUserConfig => {
		const network_type = String(deviceCard.find(".network-type-input").val());
		const roaming = Boolean(deviceCard.find(".roaming-input").prop("checked"));
		const network = String(deviceCard.find(".network-selection-input").val());
		const autoconfig = Boolean(
			deviceCard.find(".autoconfig-input").prop("checked"),
		);
		const apn = String(deviceCard.find(".apn-input").val());
		const username = String(deviceCard.find(".username-input").val());
		const password = String(deviceCard.find(".password-input").val());

		return {
			network_type,
			roaming,
			network,
			autoconfig,
			apn,
			username,
			password,
		};
	};

	deviceCard.find(".save-button").on("click", function () {
		const config = getUserConfig(deviceCard);
		config.device = deviceId;

		ws?.send(JSON.stringify({ modems: { config } }));

		$(this).prop("disabled", true);
	});

	// Disable or enable the save button depending on whether any values have changed
	const inputs = deviceCard.find("input, select");
	inputs.on("change, input", () => {
		const modemState = modems[deviceId];
		if (!modemState.config) return false;

		const userConfig = getUserConfig(deviceCard);
		const savedConfig: ModemUserConfig = Object.assign(
			{ network_type: modemState.network_type.active },
			modemState.config,
		);
		let changed = false;
		for (const i in savedConfig) {
			const key = i as keyof ModemUserConfig;
			if (userConfig[key] !== savedConfig[key]) {
				console.log(`${i} changed`);
				changed = true;
				break;
			}
		}
		deviceCard.find(".save-button").prop("disabled", !changed);
	});

	deviceCard.appendTo("#modemManager");
	return deviceCard;
}

export function updateModemsState(msg: StatusResponseMessage["modems"]) {
	for (const i in modems) {
		modems[i].removed = true;
	}

	for (const deviceId in msg) {
		if (modems[deviceId]) {
			modems[deviceId].removed = undefined;
		}

		const cardId = modemFindCardId(deviceId);
		const modemStatusUpdate = msg[deviceId];

		const isFullModemState = checkIsFullModemState(modemStatusUpdate);

		const modem = modems[deviceId];

		let deviceCard: JQuery<Node[] | HTMLElement> = $(`#${cardId}`);

		if (deviceCard.length === 0) {
			if (!isFullModemState) {
				console.error(
					`New modem (${deviceId}), but state is incomplete. Skipping.`,
				);
				continue;
			}
			deviceCard = renderDeviceCard(cardId, deviceId, modemStatusUpdate);
		}

		// The following settings may be updated for an existing modem
		if (isFullModemState && modemStatusUpdate.network_type) {
			const options: Record<string, { name: string }> = {};
			for (const i in modemStatusUpdate.network_type.supported) {
				const value = modemStatusUpdate.network_type.supported[i];
				const name = value.replace(/g/g, "G / ").replace(/ \/ $/, "");
				options[value] = { name };
			}
			deviceCard
				.find(".network-type-input")
				.html(
					genOptionList(
						[options],
						modemStatusUpdate.network_type.active,
					) as unknown as string,
				);
		}

		if (isFullModemState && modemStatusUpdate.config) {
			deviceCard.find(".apn-input").attr("value", modemStatusUpdate.config.apn);
			deviceCard
				.find(".username-input")
				.attr("value", modemStatusUpdate.config.username);
			deviceCard
				.find(".password-input")
				.attr("value", modemStatusUpdate.config.password);
			deviceCard
				.find(".roaming-input")
				.prop("checked", modemStatusUpdate.config.roaming);

			// Trigger UI updates
			if (modemStatusUpdate.config.autoconfig !== undefined) {
				deviceCard
					.find(".autoconfig-input")
					.prop("checked", modemStatusUpdate.config.autoconfig);
				deviceCard.find(".autoconfig-input").trigger("change");
			}
			deviceCard.find(".roaming-input").trigger("change");
		}

		if (modemStatusUpdate.status) {
			deviceCard
				.find(".signal")
				.html(wifiSignalSymbol(modemStatusUpdate.status.signal));
			const statusText =
				`${modemStatusUpdate.status.signal}% ${modemStatusUpdate.status.network_type || ""} ` +
				`${modemStatusUpdate.status.network || ""}${modemStatusUpdate.status.roaming ? " (R)" : ""} - ${modemStatusUpdate.status.connection}`;
			deviceCard.find(".status").text(statusText);
		}

		const networkSelect = deviceCard.find(".network-selection-input");
		if (
			isFullModemState &&
			(modemStatusUpdate.available_networks ||
				modemStatusUpdate.config ||
				networkSelect.find("option").length === 0)
		) {
			const selectedNetwork =
				modemStatusUpdate.config?.network ?? modem?.config?.network;
			const availableNetworks =
				modemStatusUpdate.available_networks ||
				(modem ? modem.available_networks : {});
			const auto = {
				"": {
					name: `Automatic${selectedNetwork ? "" : " (selected)"}`,
				},
			};
			const options: Record<string, { name: string; disabled: boolean }> = {};
			for (const i in availableNetworks) {
				let name = availableNetworks[i].name;
				let availability = "";
				if (i === selectedNetwork) {
					availability = "selected";
				}
				if (availableNetworks[i].availability) {
					if (availability) {
						availability += " & ";
					}
					availability += availableNetworks[i].availability;
				}
				if (availability) {
					name += ` (${availability})`;
				}
				options[i] = {
					name,
					disabled: availableNetworks[i].availability === "forbidden",
				};
			}
			networkSelect.html(
				genOptionList([auto, options], selectedNetwork) as unknown as string,
			);

			// Re-enable the scan button after receiving the results
			if (modemStatusUpdate.available_networks) {
				const scanButton = deviceCard.find(".network-scan-button");
				scanButton.prop("disabled", false);
				scanButton.text("Scan");
			}
		}

		// Update the cached modem state
		modems[deviceId] = Object.assign(modem || {}, modemStatusUpdate);

		// Disable or enable the save button if any settings have been updated
		if (
			isFullModemState &&
			(modemStatusUpdate.network_type || modemStatusUpdate.config)
		) {
			deviceCard.find(".network-type-input").trigger("input");
		}
	}

	for (const i in modems) {
		if (modems[i].removed) {
			const cardId = modemFindCardId(i);
			$(`#${cardId}`).remove();
			delete modems[i];
		}
	}
}
