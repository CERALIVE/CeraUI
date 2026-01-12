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

import type WebSocket from "ws";

import { getConfig } from "../config.ts";
import { buildModemsMessage } from "../modems/modem-status.ts";
import { netIfBuildMsg } from "../network/network-interfaces.ts";
import { buildRelaysMsg, getRelays } from "../remote/remote-relays.ts";
import { getAudioDevices } from "../streaming/audio.ts";
import { AUDIO_CODECS } from "@ceralive/ceracoder";
import { getPipelineList } from "../streaming/pipelines.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { getRevisions } from "../system/revisions.ts";
import { getSensors } from "../system/sensors.ts";
import {
	getAvailableUpdates,
	getSoftUpdateStatus,
} from "../system/software-updates.ts";
import { getSshStatus } from "../system/ssh.ts";
import { wifiBuildMsg } from "../wifi/wifi.ts";
import { notificationSendPersistent } from "./notifications.ts";
import { buildMsg } from "./websocket-server.ts";

export type StatusResponseMessage = {
	is_streaming?: ReturnType<typeof getIsStreaming>;
	available_updates?: ReturnType<typeof getAvailableUpdates>;
	updating?: ReturnType<typeof getSoftUpdateStatus>;
	ssh?: ReturnType<typeof getSshStatus>;
	wifi?: ReturnType<typeof wifiBuildMsg>;
	modems?: ReturnType<typeof buildModemsMessage>;
	asrcs?: Array<keyof ReturnType<typeof getAudioDevices>>;
	set_password?: boolean;
	remote?: true | { error: string };
};

export function sendStatus(conn: WebSocket) {
	conn.send(
		buildMsg("status", {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getSshStatus(),
			wifi: wifiBuildMsg(),
			modems: buildModemsMessage(),
			asrcs: Object.keys(getAudioDevices()),
		} satisfies StatusResponseMessage),
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
	conn.send(buildMsg("acodecs", AUDIO_CODECS));
	notificationSendPersistent(conn, true);
}
