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

/*
  Operator-declared regulatory country → kernel regdomain → derived AP channels.

  Ordering is load-bearing and is the same shape as `network-ingest-control.ts`:
  PERSIST FIRST, then apply. The persisted country is the truth the boot hook
  re-applies, so a device that loses power mid-apply still comes up on the
  operator's choice rather than silently reverting to the world domain.
*/

import type { SetWifiCountryOutput } from "@ceraui/rpc/schemas";
import { WORLD_REGULATORY_DOMAIN } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../../rpc/compat.ts";
import { getConfig, saveConfig } from "../config.ts";
import {
	applyRegulatoryDomain,
	getDerivedApChannels,
	planHotspotRegdomainChange,
	readRegulatoryDomain,
	refreshDerivedApChannels,
	refreshHotspotChannels,
} from "./regdomain.ts";
import { broadcastWifiState } from "./wifi.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { reconfigureHotspotForRegdomain } from "./wifi-hotspot-config.ts";
import { canHotspot, isApMode } from "./wifi-hotspot-types.ts";

/**
 * Re-derive every AP-capable adapter's offered channels, then restart the
 * hotspots the change actually affects.
 *
 * A restart is what makes a domain change REAL for a live AP: NetworkManager
 * bakes the band/channel into the activation, so an in-place field update leaves
 * the radio on the old channel. Clients re-associate on the unchanged SSID/PSK.
 */
export async function reconcileHotspotChannels(): Promise<void> {
	const derived = getDerivedApChannels();
	const interfaces = getWifiInterfacesByMacAddress();

	for (const macAddress in interfaces) {
		const wifiInterface = interfaces[macAddress];
		if (!wifiInterface || !canHotspot(wifiInterface)) continue;

		refreshHotspotChannels(wifiInterface.hotspot, derived);

		const action = planHotspotRegdomainChange(
			{
				active: isApMode(wifiInterface),
				channel: wifiInterface.hotspot.channel,
			},
			wifiInterface.hotspot.availableChannels,
		);
		if (action.kind === "none") continue;

		const channel =
			action.kind === "clamp-and-restart"
				? action.channel
				: (wifiInterface.hotspot.channel ?? "auto");

		if (action.kind === "clamp-and-restart") {
			logger.warn(
				`hotspot channel ${wifiInterface.hotspot.channel} is not permitted in the ` +
					`current regulatory domain; falling back to ${channel} on ${wifiInterface.ifname}`,
			);
		}

		await reconfigureHotspotForRegdomain(macAddress, wifiInterface, channel);
	}
}

/** Record the operator's choice without touching any radio. */
export function persistWifiCountry(
	country: string | undefined,
): SetWifiCountryOutput {
	const config = getConfig();
	config.country = country;
	saveConfig();
	broadcastMsg("config", config);

	return {
		success: true,
		...(country !== undefined ? { applied: country } : {}),
	};
}

/**
 * Persist and apply the operator's regulatory country. Never throws — a kernel
 * that cannot honour `iw reg set` reports `apply_failed` with the domain it is
 * ACTUALLY on, rather than leaving the operator with a silent no-op.
 */
export async function setWifiCountry(
	country: string | undefined,
): Promise<SetWifiCountryOutput> {
	persistWifiCountry(country);

	const target = country ?? WORLD_REGULATORY_DOMAIN;
	const applied = await applyRegulatoryDomain(target);

	await refreshDerivedApChannels();
	await reconcileHotspotChannels();
	broadcastWifiState();

	const effective = await readRegulatoryDomain();

	return {
		success: applied,
		...(country !== undefined ? { applied: country } : {}),
		...(effective !== undefined ? { effective } : {}),
		...(applied ? {} : { error: "apply_failed" as const }),
	};
}
