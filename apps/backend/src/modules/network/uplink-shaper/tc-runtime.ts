import { applyTrafficControl } from "../uplink-sharing.ts";
import type { RootQdisc } from "./applier.ts";
import { SHAPER_CONFIG, ShaperUnavailableError } from "./contracts.ts";

export async function readRootQdisc(ifname: string): Promise<RootQdisc> {
	try {
		return parseRootQdisc(
			await applyTrafficControl(["qdisc", "show", "dev", ifname]),
		);
	} catch (error) {
		throw new ShaperUnavailableError(
			"qdisc_inventory_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function parseRootQdisc(output: string): RootQdisc {
	for (const line of output.split("\n")) {
		const match = line.match(/^qdisc\s+(\S+)\s+(\S+)\s+root\b/);
		if (match?.[1] && match[2]) return { kind: match[1], handle: match[2] };
	}
	throw new ShaperUnavailableError(
		"qdisc_inventory_failed",
		"tc reported no root qdisc",
	);
}

export async function readClientBacklog(ifname: string): Promise<number> {
	const output = await applyTrafficControl([
		"-s",
		"qdisc",
		"show",
		"dev",
		ifname,
		"parent",
		`${SHAPER_CONFIG.rootHandle}2`,
	]);
	return parseBacklogBytes(output);
}

export function parseBacklogBytes(output: string): number {
	const match = output.match(/\bbacklog\s+(\d+)([KMG]?)b\b/i);
	if (!match?.[1]) return 0;
	const scale = match[2]?.toUpperCase();
	const multiplier =
		scale === "G"
			? 1_000_000_000
			: scale === "M"
				? 1_000_000
				: scale === "K"
					? 1_000
					: 1;
	return Number(match[1]) * multiplier;
}
