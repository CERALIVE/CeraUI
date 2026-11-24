import type { run } from "../../../helpers/run.ts";
import { type ClientZone, SHARE_TABLE } from "./contracts.ts";
import { MARK_GUARD } from "./mark-admission.ts";
import { MARK_FENCE_RULE } from "./route-policy.ts";

export interface MarkObservation {
	readonly guard: string;
	readonly legacy: string;
	readonly fence: boolean;
	readonly protectedZones?: readonly ClientZone[];
	readonly affected?: readonly number[];
	readonly unaffected?: readonly {
		readonly mark: number;
		readonly ifindex: number;
	}[];
}

export async function observeKernelMarks(
	command: typeof run,
): Promise<MarkObservation> {
	const nft = await command("nft", ["-nn", "list", "ruleset"]);
	const guard = tableBody(nft, MARK_GUARD);
	const legacy = tableBody(nft, SHARE_TABLE.name) ?? "";
	const rules = await command("ip", ["rule", "show"]);
	if (guard === undefined)
		return { guard: "", legacy, fence: MARK_FENCE_RULE.test(rules) };
	const receipts = [
		...guard.matchAll(/^\s*chain ((?:assignment|fenced)_\d+)\s*\{/gm),
	];
	const affected = [
		...guard.matchAll(/^\s*chain affected_(ca[0-9a-f]{4}00)\s*\{/gm),
	].map((match) => Number.parseInt(match[1] ?? "", 16));
	const protectedZones = [
		...guard.matchAll(
			/^\s*iifname "([A-Za-z0-9_.-]+)" ip saddr (\d+(?:\.\d+){3})(\/\d+)? drop\s*$/gm,
		),
	].flatMap(([, ifname, address, prefix]) =>
		ifname && address
			? [{ ifname, ipv4Cidr: `${address}${prefix ?? "/32"}` }]
			: [],
	);
	const unaffected = new Map<number, number>();
	if (affected.length > 0) {
		for (const [, hex, index] of guard.matchAll(
			/^\s*iifname "[A-Za-z0-9_.-]+" ip saddr \S+ meta mark & 0xffffff00 (?:== )?0x(ca[0-9a-f]{4}00) oif (\d+) accept\s*$/gm,
		)) {
			const mark = Number.parseInt(hex ?? "", 16);
			if (!affected.includes(mark)) unaffected.set(mark, Number(index));
		}
	}
	return {
		guard: receipts.length === 1 ? (receipts[0]?.[1] ?? "invalid") : "invalid",
		legacy,
		fence: MARK_FENCE_RULE.test(rules),
		protectedZones,
		affected,
		unaffected: [...unaffected].map(([mark, ifindex]) => ({ mark, ifindex })),
	};
}

function tableBody(ruleset: string, name: string): string | undefined {
	return new RegExp(`^table inet ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(
		ruleset,
	)?.[1];
}
