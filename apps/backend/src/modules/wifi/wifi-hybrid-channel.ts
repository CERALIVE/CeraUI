/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { argMatch, ID_RE } from "../../helpers/run.ts";
import { nmDeviceProp } from "../network/network-manager.ts";
import { deriveApChannels, parseRegulatoryDomain } from "./regdomain.ts";
import {
	fittingApStaCombination,
	isQualifiedNmManagedHybrid,
} from "./wifi-ap-sta-capability.ts";
import { parseInterfaceCombination } from "./wifi-capabilities.ts";
import { runConcurrentInterface as interfaceRunner } from "./wifi-concurrent-interface-io.ts";
import { sameLifetime } from "./wifi-hybrid-target-record.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";
import { parseRegulatoryRules, rulesForPhy } from "./wifi-regulatory-rules.ts";

export const HYBRID_CHANNEL_REFUSAL = "hybrid-channel-not-permitted";

export type HybridStationChannel = {
	readonly identity: string;
	readonly frequency: number;
	readonly sameChannelOnly: boolean;
	readonly fields: Record<string, string>;
};

/** Fresh association and exact-phy legality; cached scan/country data cannot admit up. */
export async function readHybridStationChannel(
	ifname: string,
): Promise<HybridStationChannel | undefined> {
	try {
		const parent = argMatch(ID_RE, ifname);
		const before = await sampleRadio(parent, radioIdentityReaders, undefined);
		if (!before) return undefined;
		const radio = wifiRadioIdentity.state.rows.get(parent);
		if (!radio?.lifetime || !sameLifetime(before.lifetime, radio.lifetime))
			return undefined;
		const uuid = (await nmDeviceProp(parent, "GENERAL.CON-UUID"))?.[0];
		const info = await interfaceRunner("iw", ["dev", parent, "info"]);
		const link = await interfaceRunner("iw", ["dev", parent, "link"]);
		const bssid =
			/^Connected to\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+\(on\s+(\S+)\)/im.exec(
				link,
			);
		const frequency = Number(
			/^\s*freq:\s*(\d+(?:\.\d+)?)\s*$/m.exec(link)?.[1],
		);
		const channelInfo = /^\s*channel\s+(\d+)\s+\((\d+(?:\.\d+)?) MHz\)/m.exec(
			info,
		);
		if (
			!uuid ||
			uuid === "--" ||
			!bssid ||
			bssid[2] !== parent ||
			!/^\s*type\s+managed\s*$/m.test(info) ||
			Number(channelInfo?.[2]) !== frequency ||
			Number(/^\s*ifindex\s+(\d+)\s*$/m.exec(info)?.[1]) !==
				before.lifetime.ifindex ||
			/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] !== parent ||
			Number(/^\s*wiphy\s+(\d+)\s*$/m.exec(info)?.[1]) !== before.lifetime.wiphy
		)
			return undefined;
		const phy = `phy${before.lifetime.wiphy}`;
		const phyDump = await interfaceRunner("iw", ["phy", phy, "info"]);
		const combination = fittingApStaCombination(
			phyDump,
			{
				managed: 1,
				ap: 1,
				"p2p-device": 1,
			},
			{ managed: 2, ap: 0, "p2p-device": 1 },
		);
		if (!combination) return undefined;
		const capability = parseInterfaceCombination(combination);
		if (!capability.supported) return undefined;
		const regulatory = await interfaceRunner("iw", ["reg", "get"]);
		if (!parseRegulatoryDomain(regulatory)) return undefined;
		const rules = rulesForPhy(parseRegulatoryRules(regulatory), phy);
		if (
			!rules.some(
				(rule) =>
					rule.startMhz <= frequency - 10 &&
					rule.endMhz >= frequency + 10 &&
					!rule.flags.some((flag) =>
						["no ir", "passive scan", "no ibss", "dfs"].includes(flag),
					),
			)
		)
			return undefined;
		const derived = deriveApChannels(phyDump, phy, regulatory).find(
			(entry) => entry.freqMhz === frequency,
		);
		if (
			!derived ||
			derived.channel !== Number(channelInfo?.[1]) ||
			!isQualifiedNmManagedHybrid(parent, frequency)
		)
			return undefined;
		const after = await sampleRadio(parent, radioIdentityReaders, undefined);
		if (
			!sameLifetime(after?.lifetime, before.lifetime) ||
			wifiRadioIdentity.state.rows.get(parent)?.incarnation !==
				radio.incarnation ||
			(await nmDeviceProp(parent, "GENERAL.CON-UUID"))?.[0] !== uuid
		)
			return undefined;
		return {
			identity: JSON.stringify([
				radio.incarnation,
				before.lifetime,
				uuid,
				bssid[1]?.toLowerCase(),
				frequency,
			]),
			frequency,
			sameChannelOnly: capability.sameChannelOnly,
			fields: capability.sameChannelOnly
				? {
						"802-11-wireless.band": derived.band,
						"802-11-wireless.channel": String(derived.channel),
					}
				: {},
		};
	} catch {
		return undefined;
	}
}

export async function revalidateHybridStationChannel(
	ifname: string,
	channel: HybridStationChannel,
): Promise<boolean> {
	return (
		(await readHybridStationChannel(ifname))?.identity === channel.identity
	);
}

/** NM's terminal connected AP and the actual SCC frequency must agree. */
export async function confirmHybridActivation(
	parentIfname: string,
	targetIfname: string,
	uuid: string,
	channel: HybridStationChannel,
): Promise<boolean> {
	if (!(await revalidateHybridStationChannel(parentIfname, channel)))
		return false;
	const info = await interfaceRunner("iw", [
		"dev",
		argMatch(ID_RE, targetIfname),
		"info",
	]).catch(() => "");
	const props = await nmDeviceProp(
		targetIfname,
		"GENERAL.STATE,GENERAL.NM-MANAGED,GENERAL.CON-UUID",
	);
	return (
		props?.[0] === "100 (connected)" &&
		props[1] === "yes" &&
		props[2] === uuid &&
		/^\s*type\s+AP\s*$/m.test(info) &&
		(!channel.sameChannelOnly ||
			Number(/^\s*channel\s+\d+\s+\((\d+(?:\.\d+)?) MHz\)/m.exec(info)?.[1]) ===
				channel.frequency)
	);
}
