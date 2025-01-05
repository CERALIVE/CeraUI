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

import WebSocket from "ws";

import { getConfig } from "./config.ts";
import { buildMsg } from "./websocket-server.ts";
import { notificationSendPersistent } from "./notifications.ts";
import { getIsStreaming } from "./streaming.ts";
import { audioCodecs, getAudioDevices } from "./audio.ts";
import { getPipelineList } from "./pipelines.ts";
import { buildRelaysMsg, getRelays } from "./remote.ts";
import { getSshStatus } from "./ssh.ts";
import {
	getAvailableUpdates,
	getSoftUpdateStatus,
} from "./software-updates.ts";
import { wifiBuildMsg } from "./wifi.ts";
import { modemsBuildMsg } from "./modems.ts";
import { netIfBuildMsg } from "./network-interfaces.ts";
import { getRevisions } from "./revisions.ts";
import { getSensors } from "./hardware-monitoring.ts";

export function sendStatus(conn: WebSocket) {
	conn.send(
		buildMsg("status", {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getSshStatus(),
			wifi: wifiBuildMsg(),
			modems: modemsBuildMsg(),
			asrcs: Object.keys(getAudioDevices()),
		}),
	);
}

export function sendInitialStatus(conn: WebSocket) {
	const config = getConfig();
	conn.send(buildMsg("config", config));
	conn.send(buildMsg("pipelines", getPipelineList()));
	if (getRelays()) conn.send(buildMsg("relays", buildRelaysMsg()));
	sendStatus(conn);
	conn.send(buildMsg("netif", netIfBuildMsg()));
	conn.send(buildMsg("sensors", getSensors()));
	conn.send(buildMsg("revisions", getRevisions()));
	conn.send(buildMsg("acodecs", audioCodecs));
	notificationSendPersistent(conn, true);
}
