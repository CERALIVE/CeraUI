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

import { logger } from "../../helpers/logger.ts";

export type WifiChannel = keyof typeof wifiChannels;

export const wifiChannels = {
	auto: { name: "Auto (any band)", nmBand: "", nmChannel: "" },
	auto_24: { name: "Auto (2.4 GHz)", nmBand: "bg", nmChannel: "" },
	auto_50: { name: "Auto (5.0 GHz)", nmBand: "a", nmChannel: "" },
} as const;

export const isWifiChannelName = (channel: string): channel is WifiChannel =>
	channel in wifiChannels;

export function getWifiChannelMap(channelNames: Array<string>) {
	const map: Record<string, { name: string }> = {};
	for (const e of channelNames) {
		if (isWifiChannelName(e)) {
			map[e] = { name: wifiChannels[e].name };
		} else {
			logger.info(`Unknown WiFi channel ${e}`);
		}
	}

	return map;
}

export function channelFromNM(band: string, channel: string | number) {
	for (const i in wifiChannels) {
		if (
			isWifiChannelName(i) &&
			band === wifiChannels[i].nmBand &&
			(channel === wifiChannels[i].nmChannel ||
				(channel === 0 && wifiChannels[i].nmChannel === ""))
		) {
			return i;
		}
	}

	return "auto";
}
