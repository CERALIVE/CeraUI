import type { run } from "../../../helpers/run.ts";
import {
	type ClientZone,
	SHARE_TABLE,
	SteeringUnavailableError,
} from "./contracts.ts";
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
	const named = new Map<number, string>();
	if (affected.length > 0) {
		// nft lists a live `meta oif <index>` by device name; a deleted device
		// keeps its former index, which no packet can leave through.
		for (const [line, hex, name, index] of guard.matchAll(
			/^\s*iifname "[A-Za-z0-9_.-]+" ip saddr \S+ meta mark & 0xffffff00 (?:== )?0x(ca[0-9a-f]{4}00) oif (?:"([A-Za-z0-9_.-]+)"|(\d+)) accept\s*$/gm,
		)) {
			const mark = Number.parseInt(hex ?? "", 16);
			if (affected.includes(mark)) continue;
			// A listed name that no longer resolves keeps no admission.
			const ifindex =
				name === undefined
					? Number(index)
					: await readLinkIndex(command, name).catch(() => undefined);
			if (ifindex === undefined) continue;
			unaffected.set(mark, ifindex);
			if (name !== undefined) named.set(mark, line.trim());
		}
	}
	// A resolved name still names the listed device only if a second listing
	// shows the rule unchanged; a re-created device makes nft print its old index.
	if (named.size > 0) {
		const relisted = (
			tableBody(await command("nft", ["-nn", "list", "ruleset"]), MARK_GUARD) ??
			""
		)
			.split("\n")
			.map((line) => line.trim());
		for (const [mark, line] of named)
			if (!relisted.includes(line)) unaffected.delete(mark);
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

export async function readLinkIndex(
	command: typeof run,
	ifname: string,
): Promise<number> {
	const output = await command("ip", ["-o", "link", "show", "dev", ifname]);
	const index = /^(\d+):/.exec(output)?.[1];
	if (index === undefined || Number(index) === 0)
		throw new SteeringUnavailableError(
			"policy_route_missing",
			`${ifname}: no live device index`,
		);
	return Number(index);
}

function tableBody(ruleset: string, name: string): string | undefined {
	return new RegExp(`^table inet ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(
		ruleset,
	)?.[1];
}
