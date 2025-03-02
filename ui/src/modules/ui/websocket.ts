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

import { loadConfig } from "../config.ts";
import { updateNetif } from "../network/network-interfaces.ts";
import { updateRelays } from "../remote/remote-relays.ts";
import { audioCodecs } from "../streaming/audio-codecs.ts";
import { updateBitrate } from "../streaming/bitrate.ts";
import { updatePipelines } from "../streaming/pipelines.ts";
import { updateButtonEnabledDisabled } from "../streaming/streaming.ts";
import { downloadLog } from "../system/logs.ts";
import { setRevisions } from "../system/revisions.ts";
import { updateSensors } from "../system/sensors.ts";
import { showSoftwareUpdates } from "../system/software-update.ts";
import { handleWifiResult } from "../wifi/wifi.ts";
import { handleAuthResult, tryTokenAuth } from "./auth.ts";
import { hideError, showError } from "./error-message.ts";
import { handleNotification } from "./notifications.ts";
import { updateStatus } from "./status.ts";

export let ws: WebSocket | null = null;

const websocketHost =
	import.meta.env.VITE_WEBSOCKET_HOST ?? window.location.host;

console.log(`!!! Connecting to ws://${websocketHost}`);

function tryConnect() {
	const c = new WebSocket(`ws://${websocketHost}`);
	c.addEventListener("message", (event) => {
		handleMessage(JSON.parse(event.data));
	});

	c.addEventListener("close", () => {
		ws = null;

		showError("Disconnected from BELABOX. Trying to reconnect...");
		setTimeout(tryConnect, 1000);

		updateNetact(false);
	});

	c.addEventListener("open", () => {
		ws = c;

		hideError();
		$("#notifications").empty();
		tryTokenAuth();
		updateNetact(true);
	});
}

export function initWebsocket() {
	tryConnect();

	/* WS keep-alive */
	/* If the browser / tab is in the background, the Javascript may be suspended,
       while the WS stays connected. In that case we don't want to receive periodic
       updates from the belaUI server as we'll have to walk through a potentially
       long list of stale data when the browser / tab regains focus and wakes up.

       The periodic keep-alive packets let the server know that this client is still
       active and should receive updates.
    */
	setInterval(() => {
		ws?.send(JSON.stringify({ keepalive: null }));
	}, 10000);
}

function updateNetact(isActive: boolean) {
	if (isActive) {
		$(".netact, .recheck-netact").prop("disabled", false);
		$(".recheck-netact").trigger("input");
		showSoftwareUpdates(false);
	} else {
		$(".netact, .recheck-netact").prop("disabled", true);
		updateButtonEnabledDisabled(false);
	}
}

/* Handle server-to-client messages */
// biome-ignore lint/suspicious/noExplicitAny: TODO this should be typed
function handleMessage(msg: any) {
	console.log(msg);
	for (const type in msg) {
		switch (type) {
			case "auth":
				handleAuthResult(msg[type]);
				break;
			case "revisions":
				setRevisions(msg[type]);
				break;
			case "netif":
				updateNetif(msg[type]);
				break;
			case "sensors":
				updateSensors(msg[type]);
				break;
			case "status":
				updateStatus(msg[type]);
				break;
			case "config":
				loadConfig(msg[type]);
				break;
			case "pipelines":
				updatePipelines(msg[type]);
				break;
			case "relays":
				updateRelays(msg[type]);
				break;
			case "bitrate":
				updateBitrate(msg[type]);
				break;
			case "wifi":
				handleWifiResult(msg[type]);
				break;
			case "error":
				showError(msg[type].msg);
				break;
			case "notification":
				handleNotification(msg[type]);
				break;
			case "log":
				downloadLog(msg[type]);
				break;
			case "acodecs":
				audioCodecs(msg[type]);
				break;
		}
	}
}

export async function sendCommand(cmd: unknown) {
	ws?.send(JSON.stringify({ command: cmd }));
}
