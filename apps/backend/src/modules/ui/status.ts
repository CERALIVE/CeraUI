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

import type {
	ActiveEncode,
	AudioSource,
	BufferingStatus,
	NetworkIngest,
	ResolvedAsrcReason,
} from "@ceraui/rpc/schemas";
import type WebSocket from "ws";
import { getConfig } from "../config.ts";
import { buildModemsMessage } from "../modems/modem-status.ts";
import { getNetworkIngestInfo } from "../network/network-ingest.ts";
import { netIfBuildMsg } from "../network/network-interfaces.ts";
import { buildRelaysMsg, getRelays } from "../remote/remote-relays.ts";
import { getActiveEncodeStatus } from "../streaming/active-encode-status.ts";
import { deriveAudioSources, getAudioDevices } from "../streaming/audio.ts";
import {
	getPendingAudioFollowAsrc,
	getResolvedAsrc,
	getResolvedAsrcReason,
} from "../streaming/auto-audio.ts";
import {
	buildLinkTelemetry,
	type LinkTelemetryMessage,
} from "../streaming/link-telemetry.ts";
import { AUDIO_CODECS } from "../streaming/pipeline-sources.ts";
import { getPipelinesMessage } from "../streaming/pipelines.ts";
import { getSourcesMessage } from "../streaming/sources.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { getRevisions } from "../system/revisions.ts";
import { getSensors } from "../system/sensors.ts";
import {
	getAvailableUpdates,
	getSoftUpdateStatus,
} from "../system/software-updates.ts";
import { getCachedSshStatus, getSshStatus } from "../system/ssh.ts";
import { wifiBuildMsg } from "../wifi/wifi.ts";
import { notificationSendPersistent } from "./notifications.ts";
import { buildMsg } from "./websocket-server.ts";

export type StatusResponseMessage = {
	is_streaming?: ReturnType<typeof getIsStreaming>;
	available_updates?: ReturnType<typeof getAvailableUpdates>;
	updating?: ReturnType<typeof getSoftUpdateStatus>;
	ssh?: ReturnType<typeof getCachedSshStatus>;
	wifi?: ReturnType<typeof wifiBuildMsg>;
	modems?: ReturnType<typeof buildModemsMessage>;
	asrcs?: Array<keyof ReturnType<typeof getAudioDevices>>;
	audio_sources?: AudioSource[];
	resolved_asrc?: string | null;
	resolved_asrc_reason?: ResolvedAsrcReason | null;
	pending_audio_follow_asrc?: string | null;
	set_password?: boolean;
	remote?: true | { error: string };
	linkTelemetry?: LinkTelemetryMessage | null;
	buffering?: BufferingStatus | null;
	network_ingest?: NetworkIngest | null;
	active_encode?: ActiveEncode | null;
};

export function sendStatus(conn: WebSocket) {
	// Re-probe SSH in the background; broadcasts only if the status changed.
	void getSshStatus();
	conn.send(
		buildMsg("status", {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getCachedSshStatus(),
			wifi: wifiBuildMsg(),
			modems: buildModemsMessage(),
			asrcs: Object.keys(getAudioDevices()),
			audio_sources: deriveAudioSources(),
			resolved_asrc: getResolvedAsrc(),
			resolved_asrc_reason: getResolvedAsrcReason(),
			pending_audio_follow_asrc: getPendingAudioFollowAsrc(),
			linkTelemetry: buildLinkTelemetry(),
			network_ingest: getNetworkIngestInfo(),
			active_encode: getActiveEncodeStatus(),
		} satisfies StatusResponseMessage),
	);
}

export function sendInitialStatus(conn: WebSocket) {
	const config = getConfig();
	conn.send(buildMsg("config", config));
	conn.send(buildMsg("pipelines", getPipelinesMessage()));
	conn.send(buildMsg("sources", getSourcesMessage()));
	if (getRelays()) conn.send(buildMsg("relays", buildRelaysMsg()));
	sendStatus(conn);
	conn.send(buildMsg("netif", netIfBuildMsg()));
	conn.send(buildMsg("sensors", getSensors()));
	conn.send(buildMsg("revisions", getRevisions()));
	conn.send(buildMsg("acodecs", AUDIO_CODECS));
	notificationSendPersistent(conn, true);
}
