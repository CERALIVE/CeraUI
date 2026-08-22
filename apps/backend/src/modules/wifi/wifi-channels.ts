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

/**
 * One AP-usable channel, ENUMERATED FROM the kernel's own post-regdomain answer
 * (`iw phy`) — never from a country→channel table. See `regdomain.ts` for the
 * derivation; this module only knows how to NAME and MAP what was derived.
 */
export type DerivedApChannel = {
	/** IEEE channel number as the kernel reported it. */
	channel: number;
	/** Centre frequency in MHz, used to resolve the band. */
	freqMhz: number;
	/** NetworkManager `802-11-wireless.band` value for that frequency. */
	band: "bg" | "a";
};

/**
 * The band-wide "let the kernel choose" entries. These are the ONLY static
 * channel entries — every concrete channel is derived at runtime.
 */
export const AUTO_WIFI_CHANNELS = {
	auto: { name: "Auto (any band)", nmBand: "", nmChannel: "" },
	auto_24: { name: "Auto (2.4 GHz)", nmBand: "bg", nmChannel: "" },
	auto_50: { name: "Auto (5.0 GHz)", nmBand: "a", nmChannel: "" },
} as const;

/** Historical name, kept so existing call sites read unchanged. */
export const wifiChannels = AUTO_WIFI_CHANNELS;

export type AutoWifiChannel = keyof typeof AUTO_WIFI_CHANNELS;
/** A concrete channel the kernel derived, e.g. `ch_13`. */
export type ExplicitWifiChannel = `ch_${number}`;
export type WifiChannel = AutoWifiChannel | ExplicitWifiChannel;

/** 1-999: wide enough for every IEEE channel number, narrow enough to be safe on argv. */
const EXPLICIT_CHANNEL_RE = /^ch_([1-9][0-9]{0,2})$/;

const BAND_LABELS: Record<DerivedApChannel["band"], string> = {
	bg: "2.4 GHz",
	a: "5 GHz",
};

export const isAutoWifiChannelName = (
	channel: string,
): channel is AutoWifiChannel => channel in AUTO_WIFI_CHANNELS;

/**
 * The band an auto rung PINS, or `undefined` for the any-band rung.
 *
 * BOARD-PROVEN (Rock 5B+, world domain `00`, 2026-08-22): `auto_50` writes
 * `band=a` and dies with `Failed to start AP functionality`, while `auto` writes
 * no band, lets NetworkManager settle on `frequency 2462`, and activates. So a
 * withheld band may only retire the rungs that NAME it.
 */
export function autoChannelBand(
	auto: AutoWifiChannel,
): DerivedApChannel["band"] | undefined {
	const nmBand = AUTO_WIFI_CHANNELS[auto].nmBand;
	return nmBand === "" ? undefined : nmBand;
}

export const explicitChannelId = (channel: number): ExplicitWifiChannel =>
	`ch_${channel}` as ExplicitWifiChannel;

export function explicitChannelNumber(channel: string): number | undefined {
	const match = EXPLICIT_CHANNEL_RE.exec(channel);
	if (!match?.[1]) return undefined;
	return Number(match[1]);
}

/**
 * SHAPE validation only — it answers "could this string name a channel", NOT
 * "is this channel legal here". Legality is {@link isChannelOffered}, which
 * checks the runtime-derived set.
 */
export const isWifiChannelName = (channel: string): channel is WifiChannel =>
	isAutoWifiChannelName(channel) ||
	explicitChannelNumber(channel) !== undefined;

/**
 * The authoritative acceptance test: a channel is valid iff the adapter's
 * currently-offered set (autos + derived explicit channels) contains it.
 */
export function isChannelOffered(
	channel: string,
	offered: readonly WifiChannel[],
): channel is WifiChannel {
	if (!isWifiChannelName(channel)) return false;
	return offered.includes(channel);
}

/**
 * NetworkManager band/channel pair for a channel selection, or `undefined` when
 * the channel is not in `derived` — an underived channel has no mapping BY
 * CONSTRUCTION, which is what stops an illegal channel reaching `nmcli`.
 */
export function nmSettingsForChannel(
	channel: string,
	derived: readonly DerivedApChannel[],
): { nmBand: string; nmChannel: string } | undefined {
	if (isAutoWifiChannelName(channel)) {
		const entry = AUTO_WIFI_CHANNELS[channel];
		return { nmBand: entry.nmBand, nmChannel: entry.nmChannel };
	}

	const number = explicitChannelNumber(channel);
	if (number === undefined) return undefined;

	const match = derived.find((c) => c.channel === number);
	if (!match) return undefined;

	return { nmBand: match.band, nmChannel: String(number) };
}

/** Operator-facing name for a channel selection. */
export function wifiChannelName(
	channel: string,
	derived: readonly DerivedApChannel[],
): string | undefined {
	if (isAutoWifiChannelName(channel)) return AUTO_WIFI_CHANNELS[channel].name;

	const number = explicitChannelNumber(channel);
	if (number === undefined) return undefined;

	const match = derived.find((c) => c.channel === number);
	if (!match) return undefined;

	return `Channel ${number} (${BAND_LABELS[match.band]})`;
}

export function getWifiChannelMap(
	channelNames: Array<string>,
	derived: readonly DerivedApChannel[] = [],
) {
	const map: Record<string, { name: string }> = {};
	for (const e of channelNames) {
		const name = wifiChannelName(e, derived);
		if (name !== undefined) {
			map[e] = { name };
		} else {
			logger.info(`Unknown WiFi channel ${e}`);
		}
	}

	return map;
}

export function channelFromNM(
	band: string,
	channel: string | number,
): WifiChannel {
	const number = typeof channel === "number" ? channel : Number(channel);
	if (Number.isInteger(number) && number > 0) {
		return explicitChannelId(number);
	}

	for (const i in AUTO_WIFI_CHANNELS) {
		if (
			isAutoWifiChannelName(i) &&
			band === AUTO_WIFI_CHANNELS[i].nmBand &&
			(channel === AUTO_WIFI_CHANNELS[i].nmChannel ||
				(number === 0 && AUTO_WIFI_CHANNELS[i].nmChannel === ""))
		) {
			return i;
		}
	}

	return "auto";
}
