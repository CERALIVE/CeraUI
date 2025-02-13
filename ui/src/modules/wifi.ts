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
	WifiInterfaceResponseMessage,
	WifiNetwork,
} from "../../../server/modules/wifi.ts";
import { genOptionList } from "./options-list.ts";
import { showHidePassword } from "./password-box.ts";
import { ws } from "./websocket.ts";

declare global {
	interface Window {
		wifiScan: typeof wifiScan;
		wifiSendNewConnection: typeof wifiSendNewConnection;
		wifiConnect: typeof wifiConnect;
		wifiDisconnect: typeof wifiDisconnect;
		wifiForget: typeof wifiForget;
	}
}

window.wifiScan = wifiScan;
window.wifiSendNewConnection = wifiSendNewConnection;
window.wifiConnect = wifiConnect;
window.wifiDisconnect = wifiDisconnect;
window.wifiForget = wifiForget;

/* WiFi manager */
export function wifiScan(button: HTMLElement, deviceId: string) {
	// Disable the search button immediately
	const wifiManager = $(button).parents(".wifi-settings");
	wifiManager.find(".wifi-scan-button").prop("disabled", true);

	// Send the request
	ws?.send(JSON.stringify({ wifi: { scan: deviceId } }));

	// Duration
	const searchDuration = 10000;

	setTimeout(() => {
		wifiManager.find(".wifi-scan-button").prop("disabled", false);
		wifiManager.find(".scanning").addClass("d-none");
	}, searchDuration);

	wifiManager.find(".connect-error").addClass("d-none");
	wifiManager.find(".scanning").removeClass("d-none");
}

function wifiSendNewConnection() {
	$("#wifiNewErrAuth").addClass("d-none");
	$("#wifiNewErrGeneric").addClass("d-none");
	$("#wifiNewConnecting").removeClass("d-none");

	$("#wifiConnectButton").prop("disabled", true);

	const device = $("#connection-device").val();
	const ssid = $("#connection-ssid").val();
	const password = $("#connection-password").val();

	ws?.send(
		JSON.stringify({
			wifi: {
				new: {
					device,
					ssid,
					password,
				},
			},
		}),
	);

	return false;
}

function wifiConnect(e: HTMLElement) {
	const network = $(e).parents("tr.network").data("network");

	if (network.active) return;

	if (network.uuid) {
		ws?.send(JSON.stringify({ wifi: { connect: network.uuid } }));

		const wifiManager = $(e).parents(".wifi-settings");
		wifiManager.find(".connect-error").addClass("d-none");
		wifiManager.find(".connecting").removeClass("d-none");
	} else {
		if (network.security === "") {
			if (confirm(`Connect to the open network ${network.ssid}?`)) {
				ws?.send(
					JSON.stringify({
						wifi: {
							new: {
								ssid: network.ssid,
								device: network.device,
							},
						},
					}),
				);
			}
		} else {
			if (network.security.match("802.1X")) {
				alert(
					"This network uses 802.1X enterprise authentication, " +
						"which belaUI doesn't support at the moment",
				);
			} else if (network.security.match("WEP")) {
				alert(
					"This network uses legacy WEP authentication, " +
						"which belaUI doesn't support",
				);
			} else {
				$("#connection-ssid").val(network.ssid);
				$("#connection-device").val(network.device);
				$("#connection-password").val("");
				$(".wifi-new-status").addClass("d-none");
				$("#wifiConnectButton").prop("disabled", false);
				$("#wifiModal").modal({ show: true });

				setTimeout(() => {
					$("#connection-password").focus();
				}, 500);
			}
		}
	}
}

function wifiDisconnect(e: HTMLElement) {
	const network = $(e).parents("tr").data("network");

	if (confirm(`Disconnect from ${network.ssid}?`)) {
		ws?.send(
			JSON.stringify({
				wifi: {
					disconnect: network.uuid,
				},
			}),
		);
	}
}

function wifiForget(e: HTMLElement) {
	const network = $(e).parents("tr").data("network");

	if (confirm(`Forget network ${network.ssid}?`)) {
		ws?.send(
			JSON.stringify({
				wifi: {
					forget: network.uuid,
				},
			}),
		);
	}
}

function wifiFindCardId(deviceId: number) {
	return `wifi-manager-${deviceId}`;
}

export function wifiSignalSymbol(signal_: number) {
	let signal = signal_;
	if (signal < 0) signal = 0;
	if (signal > 100) signal = 100;
	const symbol = 9601 + Math.floor(signal / 12.51);
	let cl = "text-success";
	if (signal < 40) {
		cl = "text-danger";
	} else if (signal < 75) {
		cl = "text-warning";
	}
	return `<span class="${cl}">&#${symbol}</span>`;
}

function wifiListAvailableNetwork(
	device: { saved: Record<string, string> },
	deviceId: number,
	a: WifiNetwork,
) {
	const savedUuid = device.saved[a.ssid];
	if (savedUuid) {
		delete device.saved[a.ssid];
	}

	const html = `
    <tr class="network">
      <td class="signal px-0"></td>
      <td class="band px-0"></td>
      <td class="security px-0"></td>
      <td class="text-break">
        <span class="connected d-none"><u>Connected</u><br/></span>
        <span class="ssid" onClick="wifiConnect(this)"></span>
      </td>
      <td class="text-right px-0">
        <button class="d-none btn btn-warning px-1 py-0 disconnect btn-sm netact"
                onClick="wifiDisconnect(this)" title="Disconnect">
          <span class="font-weight-bold button-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-wifi-off" viewBox="0 0 16 16">
              <path d="M10.706 3.294A12.545 12.545 0 0 0 8 3C5.259 3 2.723 3.882.663 5.379a.485.485 0 0 0-.048.736.518.518 0 0 0 .668.05A11.448 11.448 0 0 1 8 4c.63 0 1.249.05 1.852.148l.854-.854zM8 6c-1.905 0-3.68.56-5.166 1.526a.48.48 0 0 0-.063.745.525.525 0 0 0 .652.065 8.448 8.448 0 0 1 3.51-1.27L8 6zm2.596 1.404.785-.785c.63.24 1.227.545 1.785.907a.482.482 0 0 1 .063.745.525.525 0 0 1-.652.065 8.462 8.462 0 0 0-1.98-.932zM8 10l.933-.933a6.455 6.455 0 0 1 2.013.637c.285.145.326.524.1.75l-.015.015a.532.532 0 0 1-.611.09A5.478 5.478 0 0 0 8 10zm4.905-4.905.747-.747c.59.3 1.153.645 1.685 1.03a.485.485 0 0 1 .047.737.518.518 0 0 1-.668.05 11.493 11.493 0 0 0-1.811-1.07zM9.02 11.78c.238.14.236.464.04.66l-.707.706a.5.5 0 0 1-.707 0l-.707-.707c-.195-.195-.197-.518.04-.66A1.99 1.99 0 0 1 8 11.5c.374 0 .723.102 1.021.28zm4.355-9.905a.53.53 0 0 1 .75.75l-10.75 10.75a.53.53 0 0 1-.75-.75l10.75-10.75z"/>
            </svg>
          </span>
          <span class="button-text">Disconnect</span>
        </button>
        <button class="d-none btn btn-danger px-1 py-0 forget btn-sm netact"
                onClick="wifiForget(this)" title="Forget">
          <span class="font-weight-bold button-icon">&#128465;</span>
          <span class="button-text">Forget</span>
        </button>
      </td>
    </tr>`;

	const network = $($.parseHTML(html));
	network.find(".signal").html(wifiSignalSymbol(a.signal)); // + '%');
	network.find(".band").html(a.freq > 5000 ? "5&#13203;" : "2.4&#13203;");
	const ssidEl = network.find(".ssid");
	ssidEl.text(a.ssid);

	network.data("network", {
		active: a.active,
		uuid: savedUuid,
		ssid: a.ssid,
		device: deviceId,
		security: a.security,
	});

	if (a.security) {
		// show a cross mark for 802.1X or WEP networks (unsupported)
		// or a lock symbol for PSK networks (supported)
		network
			.find(".security")
			.html(a.security.match(/802\.1X|WEP/) ? "&#10060;" : "&#128274;");
	}
	if (a.active) {
		network.find(".disconnect").removeClass("d-none");
		network.find(".connected").removeClass("d-none");
	}
	if (!a.active) {
		network.find(".ssid").addClass("can-connect");
	}
	if (savedUuid) {
		network.find(".forget").removeClass("d-none");
	}

	return network;
}

function wifiListSavedNetwork(ssid: string, uuid: string) {
	const html = `
    <tr class="network">
      <td class="ssid col-11"></td>
      <td class="col-1">
        <button class="btn btn-danger px-1 py-0 forget btn-sm netact"
                onClick="wifiForget(this)" title="Forget">
          <span class="font-weight-bold button-icon">&#128465;</span>
          <span class="button-text">Forget</span>
        </button>
      </td>
    </tr>`;

	const network = $($.parseHTML(html));
	network.find(".ssid").text(ssid);

	network.data("network", { ssid, uuid });

	return network;
}

function wifiCheckHotspotSettings(deviceId: number) {
	const interfaceOptions = wifiIfs[deviceId];
	if (!interfaceOptions?.hotspot) return;

	const cardId = wifiFindCardId(deviceId);
	const form = $(`#${cardId}`).find(".hotspot");

	let anyValueChanged = false;
	let allValuesValid = true;

	const nameInput = String(form.find(".hotspot-name").val());
	if (nameInput && nameInput !== interfaceOptions.hotspot.name) {
		anyValueChanged = true;
		const hint = form.find(".hotspot-name-hint");
		if (nameInput.length < 1 || nameInput.length > 32) {
			hint.removeClass("d-none");
			allValuesValid = false;
		} else {
			hint.addClass("d-none");
		}
	}

	const passwordInput = String(form.find(".hotspot-password").val());
	if (passwordInput && passwordInput !== interfaceOptions.hotspot.password) {
		anyValueChanged = true;
		const hint = form.find(".hotspot-password-hint");
		if (passwordInput.length < 8 || passwordInput.length > 64) {
			hint.removeClass("d-none");
			allValuesValid = false;
		} else {
			hint.addClass("d-none");
		}
	}

	const channelInput = String(form.find(".hotspot-channel").val());
	if (channelInput && channelInput !== interfaceOptions.hotspot.channel) {
		anyValueChanged = true;
	}

	form
		.find(".hotspot-config-save")
		.prop("disabled", !anyValueChanged || !allValuesValid);
}

type WifiInterfaces = Record<
	number,
	WifiInterfaceResponseMessage & { removed?: boolean }
>;

let wifiIfs: WifiInterfaces = {};

export function resetWifiInterfaces() {
	wifiIfs = {};
}

export function updateWifiState(
	msg: Record<number, WifiInterfaceResponseMessage>,
) {
	for (const i in wifiIfs) {
		wifiIfs[i].removed = true;
	}

	for (const deviceId_ in msg) {
		const deviceId = Number.parseInt(deviceId_, 10);

		// Mark the interface as not removed
		if (wifiIfs[deviceId]) {
			wifiIfs[deviceId].removed = undefined;
		}

		const cardId = wifiFindCardId(deviceId);
		const device = msg[deviceId];
		let deviceCard: JQuery<Node[] | HTMLElement> = $(`#${cardId}`);

		if (deviceCard.length === 0) {
			const html = `
        <div id="${cardId}" class="wifi-settings card mb-2">
          <div class="card-header bg-success text-center" type="button" data-toggle="collapse" data-target="#collapseWifi-${deviceId}">
            <button class="btn btn-link text-white" type="button" data-toggle="collapse" data-target="#collapseWifi-${deviceId}" aria-expanded="false" aria-controls="collapseWifi-${deviceId}">
              Wifi: <strong class="device-name"></strong><span class="device-hw"></span>
            </button>
          </div>

          <div class="collapse" id="collapseWifi-${deviceId}">
            <div class="card-body">
              <div class="hotspot d-none">
                <p class="hotspot-modified hotspot-warning d-none text-danger">The NetworkManager connection for the hotspot has been modified from the BELABOX defaults. Correct functionality can't be guaranteed. If you experience issues, please delete it via command line</p>

                <div class="form-group">
                  <label>Network name</label>
                  <p class="hotspot-name-hint text-danger d-none">The network name must be between 1 and 32 characters long</p>
                  <input type="text" class="form-control hotspot-name recheck-netact">
                </div>

                <div class="form-group">
                  <label>Password</label>
                  <p class="hotspot-password-hint text-danger d-none">The password must be between 8 and 64 characters long</p>
                  <div class="input-group">
                    <input type="password" class="form-control hotspot-password netact">
                    <div class="input-group-append">
                      <button class="btn btn-outline-secondary showHidePassword" type="button">Show</button>
                    </div>
                  </div>
                </div>

                <div class="form-group">
                  <label>Wifi channel</label>
                  <select class="form-control hotspot-channel netact">
                  </select>
                </div>

                <div class="text-danger form-group save-error small d-none"></div>
                <div class="text-info form-group saving small d-none"><div class="spinner-border spinner-border-sm"></div> Saving...</div>
                <div class="text-success form-group saved small d-none">Saved</div>

                <button class="btn btn-block btn-primary mb-2 hotspot-config-save netact" disabled>Save</button>
                <button class="btn btn-block btn-warning mb-2 client-mode netact">Turn hotspot off</button>
              </div> <!-- .hotspot -->

              <div class="client d-none">
                <button type="button" class="btn btn-block btn-secondary btn-netact mb-2 wifi-scan-button" onClick="wifiScan(this, ${deviceId})">
                  Scan for WiFi networks
                </button>

                <div class="connecting small text-info d-none">
                  <div class="spinner-border spinner-border-sm" role="status">
                  </div>
                  Connecting...
                </div>

                <div class="connect-error small text-info d-none">
                  Error connecting to the network. Has the password changed?
                </div>

                <div class="scanning small text-info d-none">
                  <div class="spinner-border spinner-border-sm" role="status">
                  </div>
                  Scanning...
                </div>

                <table class="table mb-2 table-hover table-sm small">
                  <tbody class="networks available-networks"></tbody>
                </table>

                <table class="d-none table mt-4 table-hover table-sm small saved-networks">
                  <thead>
                    <th colspan=2>Other saved networks</th>
                  </thead>
                  <tbody class="networks saved-networks"></tbody>
                </table>

                <button class="btn btn-block btn-warning mb-2 hotspot-mode netact" disabled>Hotspot mode</button>
              </div> <!-- .client -->
            </div>
          </div>
        </div>`;

			deviceCard = $($.parseHTML(html));

			deviceCard.find("button.showHidePassword").on("click", showHidePassword);

			deviceCard.find("button.hotspot-mode").on("click", () => {
				if (
					confirm(
						"This will immediately disconnect the WiFi adapter from any connected networks and turn on the hotspot. Proceed?",
					)
				) {
					ws?.send(
						JSON.stringify({
							wifi: { hotspot: { start: { device: deviceId } } },
						}),
					);
				}
			});

			deviceCard.find("button.client-mode").on("click", () => {
				if (
					confirm(
						"This will immediately disconnect any connected clients and disable the hotspot. Proceed?",
					)
				) {
					ws?.send(
						JSON.stringify({
							wifi: { hotspot: { stop: { device: deviceId } } },
						}),
					);
				}
			});

			deviceCard
				.find(".hotspot-name, .hotspot-password, .hotspot-channel")
				.on("input", () => {
					wifiCheckHotspotSettings(deviceId);
				});

			deviceCard.find("button.hotspot-config-save").on("click", function () {
				const config = {
					device: deviceId,
					name: deviceCard.find("input.hotspot-name").val(),
					password: deviceCard.find("input.hotspot-password").val(),
					channel: deviceCard.find("select.hotspot-channel").val(),
				};
				ws?.send(JSON.stringify({ wifi: { hotspot: { config } } }));

				$(this).prop("disabled", true);
				deviceCard.find(".save-error, .saved").addClass("d-none");
				deviceCard.find(".saving").removeClass("d-none");
			});

			deviceCard.appendTo("#wifi");
		}

		// Update the card's header
		deviceCard.find(".device-name").text(device.ifname);
		deviceCard.find(".device-hw").text(device.hw ? ` (${device.hw})` : "");

		// Disable or enable the hotspot mode button depending on whether the hardware supports it
		deviceCard
			.find("button.hotspot-mode")
			.prop("disabled", !device.supports_hotspot && !device.hotspot);

		if (device.hotspot) {
			if (
				!wifiIfs[deviceId] ||
				!wifiIfs[deviceId].hotspot ||
				wifiIfs[deviceId].hotspot.name !== device.hotspot.name
			) {
				deviceCard.find(".hotspot-name").val(device.hotspot.name ?? "");
			}
			if (
				!wifiIfs[deviceId] ||
				!wifiIfs[deviceId].hotspot ||
				wifiIfs[deviceId].hotspot.password !== device.hotspot.password
			) {
				deviceCard.find(".hotspot-password").val(device.hotspot.password ?? "");
			}
			if (
				!wifiIfs[deviceId] ||
				!wifiIfs[deviceId].hotspot ||
				wifiIfs[deviceId].hotspot.channel !== device.hotspot.channel
			) {
				const channels = genOptionList(
					[device.hotspot.available_channels],
					device.hotspot.channel,
				);
				deviceCard
					.find("select.hotspot-channel")
					.html(channels as unknown as string);
			}

			if (device.hotspot.warnings?.includes("modified")) {
				deviceCard.find(".hotspot-modified").removeClass("d-none");
			} else {
				deviceCard.find(".hotspot-modified").addClass("d-none");
			}

			deviceCard.find(".client").addClass("d-none");
			deviceCard.find(".hotspot").removeClass("d-none");
		} else {
			// Show the available networks
			let networkList = [];

			const availableNetworks = msg[deviceId].available ?? [];
			for (const a of availableNetworks) {
				if (a.active) {
					networkList.push(wifiListAvailableNetwork(device, deviceId, a));
				}
			}

			for (const a of availableNetworks) {
				if (!a.active) {
					networkList.push(wifiListAvailableNetwork(device, deviceId, a));
				}
			}

			deviceCard
				.find(".available-networks")
				.html(networkList as unknown as string);

			// Show the saved networks
			networkList = [];
			for (const ssid in msg[deviceId].saved) {
				const uuid = msg[deviceId].saved[ssid];
				networkList.push(wifiListSavedNetwork(ssid, uuid));
			}

			if (networkList.length) {
				deviceCard
					.find("tbody.saved-networks")
					.html(networkList as unknown as string);
				deviceCard.find("table.saved-networks").removeClass("d-none");
			} else {
				deviceCard.find("table.saved-networks").addClass("d-none");
			}

			deviceCard.find(".hotspot").addClass("d-none");
			deviceCard.find(".client").removeClass("d-none");
		}
	}

	for (const i in wifiIfs) {
		const deviceId = Number.parseInt(i, 10);

		if (wifiIfs[deviceId].removed) {
			const cardId = wifiFindCardId(deviceId);
			$(`#${cardId}`).remove();
		}
	}

	wifiIfs = msg;
}

export function handleWifiResult(msg: {
	device: number;
	connect?: boolean;
	new?: { error?: string; success?: boolean };
	hotspot?: {
		config: {
			success?: boolean;
			error?: string;
			device: number;
		};
	};
}) {
	if (msg.connect !== undefined) {
		const wifiManagerId = `#${wifiFindCardId(msg.device)}`;
		$(wifiManagerId).find(".connecting").addClass("d-none");
		if (!msg.connect) {
			$(wifiManagerId).find(".connect-error").removeClass("d-none");
		}
	} else if (msg.new) {
		if (msg.new.error) {
			$("#wifiNewConnecting").addClass("d-none");

			switch (msg.new.error) {
				case "auth":
					$("#wifiNewErrAuth").removeClass("d-none");
					break;
				case "generic":
					$("#wifiNewErrGeneric").removeClass("d-none");
					break;
			}

			$("#wifiConnectButton").prop("disabled", false);
		}
		if (msg.new.success) {
			$("#wifiModal").modal("hide");
		}
	} else if (msg.hotspot) {
		if (msg.hotspot.config) {
			const wifiManager = $(`#${wifiFindCardId(msg.hotspot.config.device)}`);

			if (msg.hotspot.config.success) {
				wifiManager.find(".save-error, .saving").addClass("d-none");
				wifiManager.find(".saved").removeClass("d-none");
			} else if (msg.hotspot.config.error) {
				let errMsg: string | undefined;

				switch (msg.hotspot.config.error) {
					case "name":
					case "password":
					case "channel":
						errMsg = `invalid ${msg.hotspot.config.error}`;
						break;
					case "saving":
					case "activating":
						errMsg = "couldn't apply the new settings";
						break;
				}
				if (errMsg) {
					const errorField = wifiManager.find(".save-error");
					errorField.text(`Failed to save the settings: ${errMsg}`);
					wifiManager.find(".saved, .saving").addClass("d-none");
					errorField.removeClass("d-none");
				}
			}
		}
	}
}
