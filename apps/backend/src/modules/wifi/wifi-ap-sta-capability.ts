/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { argMatch, ID_RE, run } from "../../helpers/run.ts";

type CapabilityRunner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: CapabilityRunner = (command, args) => run(command, args);
let capabilityRunner: CapabilityRunner = defaultRunner;

const cachedPhySupport = new Map<string, boolean>();
const WIPHY_RE = /^\s*wiphy\s+(\d+)\s*$/im;
const COMBINATION_START_RE = /^\s*\*\s+#\{/;
const LIMIT_RE = /#\{\s*([^}]+)\s*\}\s*<=\s*(\d+)/g;
const TOTAL_RE = /\btotal\s*<=\s*(\d+)/i;
const CHANNELS_RE = /#channels\s*<=\s*(\d+)/i;

function combinationAllowsApSta(combination: string): boolean {
	const total = Number(TOTAL_RE.exec(combination)?.[1]);
	const channels = Number(CHANNELS_RE.exec(combination)?.[1]);
	if (!Number.isInteger(total) || total < 2) return false;
	if (!Number.isInteger(channels) || channels < 1) return false;

	let managedMentioned = false;
	let apMentioned = false;
	LIMIT_RE.lastIndex = 0;
	for (const match of combination.matchAll(LIMIT_RE)) {
		const names = new Set(
			(match[1] ?? "")
				.split(",")
				.map((name) => name.trim().toLowerCase())
				.filter(Boolean),
		);
		const limit = Number(match[2]);
		const requiresManaged = names.has("managed");
		const requiresAp = names.has("ap");
		managedMentioned ||= requiresManaged;
		apMentioned ||= requiresAp;
		const requiredFromGroup = Number(requiresManaged) + Number(requiresAp);
		if (requiredFromGroup > limit) return false;
	}

	return managedMentioned && apMentioned;
}

/**
 * Read cfg80211's simultaneous-interface contract. Support is proven only when
 * one complete alternative permits one managed interface and one AP interface.
 */
export function parseApStaConcurrencySupport(output: string): boolean {
	let inCombinations = false;
	let current = "";

	const finish = (): boolean => {
		if (current === "") return false;
		const allows = combinationAllowsApSta(current);
		current = "";
		return allows;
	};

	for (const line of output.split("\n")) {
		if (/valid interface combinations:/i.test(line)) {
			if (finish()) return true;
			inCombinations = true;
			continue;
		}
		if (!inCombinations) continue;

		if (COMBINATION_START_RE.test(line)) {
			if (finish()) return true;
			current = line.trim();
			continue;
		}
		if (current === "") continue;

		current += ` ${line.trim()}`;
		if (TOTAL_RE.test(current) && CHANNELS_RE.test(current)) {
			if (finish()) return true;
		}
	}

	return finish();
}

function parsePhyName(output: string): string | undefined {
	const index = WIPHY_RE.exec(output)?.[1];
	return index === undefined ? undefined : `phy${index}`;
}

export async function supportsApStaConcurrency(
	ifname: string,
): Promise<boolean> {
	try {
		const deviceInfo = await capabilityRunner("iw", [
			"dev",
			argMatch(ID_RE, ifname),
			"info",
		]);
		const phy = parsePhyName(deviceInfo);
		if (phy === undefined) return false;

		const cached = cachedPhySupport.get(phy);
		if (cached !== undefined) return cached;

		const phyInfo = await capabilityRunner("iw", ["phy", phy, "info"]);
		const supported = parseApStaConcurrencySupport(phyInfo);
		cachedPhySupport.set(phy, supported);
		return supported;
	} catch {
		return false;
	}
}

export function setApStaCapabilityRunnerForTest(
	runner: CapabilityRunner | null,
): void {
	capabilityRunner = runner ?? defaultRunner;
	cachedPhySupport.clear();
}

export function resetApStaCapabilityStateForTest(): void {
	capabilityRunner = defaultRunner;
	cachedPhySupport.clear();
}
