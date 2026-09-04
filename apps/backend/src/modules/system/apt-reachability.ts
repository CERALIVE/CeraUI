/*
	CeraUI - web UI for the CeraLive project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { readdir } from "node:fs/promises";

import type {
	AptFamilyProbe,
	AptReachability as AptReachabilityWire,
} from "@ceraui/rpc";

import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";
import { type AptOrigin, parseAptSourceOrigins } from "./apt-source-origins.ts";

export { type AptOrigin, parseAptSourceOrigins } from "./apt-source-origins.ts";

const APT_SOURCE_DIR = "/etc/apt/sources.list.d";
const PROBE_TIMEOUT_MS = 4_000;

export const APT_REACHABILITY_TTL_MS = 60_000;

export type AptReachabilityVerdict =
	| "force_ipv4"
	| "force_ipv6"
	| "any"
	| "unreachable"
	| "captive_portal";

export type AptOriginProbe = {
	readonly origin: AptOrigin;
	readonly ipv4: AptFamilyProbe;
	readonly ipv6: AptFamilyProbe;
};

export type AptReachability = AptReachabilityWire & {
	readonly verdict: AptReachabilityVerdict;
	readonly detail: readonly {
		readonly origin: string;
		readonly family: "ipv4" | "ipv6";
		readonly result: AptFamilyProbe;
	}[];
};

export type AptReachabilityDeps = {
	readonly readSources: () => Promise<string>;
	readonly runProbe: (
		argv: string[],
	) => Promise<Pick<SpawnWithTimeoutResult, "exitCode" | "stdout">>;
	readonly now?: () => number;
	readonly maxAgeMs?: number;
};

export function buildProbeArgv(family: 4 | 6, url: string): string[] {
	return [
		"curl",
		family === 4 ? "-4" : "-6",
		"--connect-timeout",
		"2",
		"--max-time",
		"3",
		"-sS",
		"-I",
		"-o",
		"/dev/null",
		"-w",
		"%{http_code} %{redirect_url}",
		url,
	];
}

export function classifyProbe(outcome: {
	readonly exitCode: number;
	readonly stdout: string;
	readonly originHost: string;
	readonly scheme: AptOrigin["scheme"];
}): AptFamilyProbe {
	if (outcome.exitCode === 0) {
		const [rawCode, ...redirectParts] = outcome.stdout.trim().split(/\s+/);
		const code = Number.parseInt(rawCode ?? "", 10);
		if (code >= 100) {
			const redirectUrl = redirectParts.join(" ");
			if (outcome.scheme === "http" && code >= 300 && code < 400) {
				try {
					if (
						redirectUrl !== "" &&
						new URL(redirectUrl).host.toLowerCase() !==
							outcome.originHost.toLowerCase()
					) {
						return "captive";
					}
				} catch {
					return "ok";
				}
			}
			return "ok";
		}
	}

	switch (outcome.exitCode) {
		case 28:
			return "blocked";
		case 7:
			return "no_route";
		case 6:
			return "dns_failed";
		default:
			return "unknown";
	}
}

function foldFamily(
	byOrigin: readonly AptOriginProbe[],
	family: "ipv4" | "ipv6",
): AptFamilyProbe {
	if (byOrigin.length === 0) return "unknown";
	if (byOrigin.every((entry) => entry[family] === "ok")) return "ok";
	if (byOrigin.some((entry) => entry[family] === "captive")) return "captive";
	return (
		byOrigin.find((entry) => entry[family] !== "ok")?.[family] ?? "unknown"
	);
}

export function deriveVerdict(
	byOrigin: readonly AptOriginProbe[],
): AptReachability {
	const ipv4 = foldFamily(byOrigin, "ipv4");
	const ipv6 = foldFamily(byOrigin, "ipv6");
	const ipv4Usable = byOrigin.length > 0 && ipv4 === "ok";
	const ipv6Usable = byOrigin.length > 0 && ipv6 === "ok";
	const captive = ipv4 === "captive" || ipv6 === "captive";
	const verdict: AptReachabilityVerdict = ipv4Usable
		? ipv6Usable
			? "any"
			: "force_ipv4"
		: ipv6Usable
			? "force_ipv6"
			: captive
				? "captive_portal"
				: "unreachable";
	const used =
		verdict === "any"
			? "any"
			: verdict === "force_ipv4"
				? "ipv4"
				: verdict === "force_ipv6"
					? "ipv6"
					: "none";
	const detail: AptReachability["detail"][number][] = [];
	for (const entry of byOrigin) {
		for (const family of ["ipv4", "ipv6"] as const) {
			const result = entry[family];
			if (result !== "ok") {
				detail.push({ origin: entry.origin.url, family, result });
			}
		}
	}
	return { ipv4, ipv6, used, verdict, detail };
}

async function readAptSources(): Promise<string> {
	const names = (await readdir(APT_SOURCE_DIR))
		.filter((name) => name.endsWith(".sources"))
		.sort();
	return (
		await Promise.all(
			names.map((name) => Bun.file(`${APT_SOURCE_DIR}/${name}`).text()),
		)
	).join("\n\n");
}

export const defaultAptReachabilityDeps: AptReachabilityDeps = {
	readSources: readAptSources,
	runProbe: (argv) => spawnWithTimeout(argv, { timeoutMs: PROBE_TIMEOUT_MS }),
};

let cache: { readonly at: number; readonly value: AptReachability } | undefined;

export function resetAptReachabilityCacheForTest(): void {
	cache = undefined;
}

export async function probeAptReachability(
	deps: AptReachabilityDeps = defaultAptReachabilityDeps,
): Promise<AptReachability> {
	const now = deps.now?.() ?? Date.now();
	const maxAgeMs = deps.maxAgeMs ?? APT_REACHABILITY_TTL_MS;
	const age = cache === undefined ? undefined : now - cache.at;
	if (cache !== undefined && age !== undefined && age >= 0 && age < maxAgeMs) {
		return cache.value;
	}

	let origins: AptOrigin[];
	try {
		origins = parseAptSourceOrigins(await deps.readSources());
	} catch {
		const value = deriveVerdict([]);
		cache = { at: now, value };
		return value;
	}

	const byOrigin = await Promise.all(
		origins.map(async (origin): Promise<AptOriginProbe> => {
			const probe = async (family: 4 | 6): Promise<AptFamilyProbe> => {
				try {
					const result = await deps.runProbe(
						buildProbeArgv(family, origin.probeUrl),
					);
					return classifyProbe({
						exitCode: result.exitCode,
						stdout: result.stdout,
						originHost: origin.host,
						scheme: origin.scheme,
					});
				} catch {
					return "unknown";
				}
			};
			const [ipv4, ipv6] = await Promise.all([probe(4), probe(6)]);
			return { origin, ipv4, ipv6 };
		}),
	);
	const value = deriveVerdict(byOrigin);
	cache = { at: now, value };
	return value;
}
