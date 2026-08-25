import type { UplinkRoutePlan } from "./applier.ts";
import {
	FWMARK_RULE_PRIORITY,
	SOURCE_ROUTE_RULE_PRIORITY,
	UPLINK_MARK_MASK,
} from "./contracts.ts";
import { routeUnavailable } from "./route-errors.ts";

export interface OwnedFwmarkRule {
	readonly mark: number;
	readonly table: string;
}

export interface ManagedSourceRule {
	readonly sourceAddress: string;
	readonly priority: number;
}

export function hasFwmarkRule(output: string, plan: UplinkRoutePlan): boolean {
	const mark = `${hexMark(plan.mark)}/${hexMark(UPLINK_MARK_MASK)}`;
	return output.split("\n").some((line) => {
		const priority = rulePriority(line);
		return (
			priority === FWMARK_RULE_PRIORITY &&
			line.includes(`fwmark ${mark}`) &&
			(line.includes(`lookup ${plan.table}`) ||
				line.includes(`table ${plan.table}`))
		);
	});
}

export function hasForeignFwmarkPriorityRule(output: string): boolean {
	return output.split("\n").some((line) => {
		if (rulePriority(line) !== FWMARK_RULE_PRIORITY) return false;
		return !/\bfwmark\s+0xca[0-9a-f]{6}\/0xffffff00\s+(?:lookup|table)\s+\S+/i.test(
			line,
		);
	});
}

export function parseOwnedFwmarkRules(output: string): OwnedFwmarkRule[] {
	const rules: OwnedFwmarkRule[] = [];
	for (const line of output.split("\n")) {
		if (rulePriority(line) !== FWMARK_RULE_PRIORITY) continue;
		const match = line.match(
			/\bfwmark\s+(0xca[0-9a-f]{6})\/0xffffff00\s+(?:lookup|table)\s+(\S+)/i,
		);
		if (!match?.[1] || !match[2]) continue;
		rules.push({ mark: Number.parseInt(match[1], 16) >>> 0, table: match[2] });
	}
	return rules;
}

export function findManagedSourceRule(
	output: string,
	table: string,
): ManagedSourceRule | undefined {
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(\d+):\s+from\s+(\S+)\s+lookup\s+(\S+)/);
		if (!match?.[1] || !match[2] || match[3] !== table) continue;
		const priority = Number.parseInt(match[1], 10);
		if (priority !== SOURCE_ROUTE_RULE_PRIORITY) continue;
		return {
			sourceAddress: match[2].replace(/\/32$/, ""),
			priority,
		};
	}
	return undefined;
}

export function assertFwmarkPriorityAvailable(
	output: string,
	ifname: string,
): void {
	if (!hasForeignFwmarkPriorityRule(output)) return;
	throw routeUnavailable(
		ifname,
		`priority ${FWMARK_RULE_PRIORITY} is occupied by a foreign rule`,
	);
}

export function hasSourceRule(output: string, plan: UplinkRoutePlan): boolean {
	if (plan.sourceRulePriority === undefined) return false;
	return output.split("\n").some((line) => {
		return (
			rulePriority(line) === plan.sourceRulePriority &&
			(line.includes(`from ${plan.sourceAddress} `) ||
				line.includes(`from ${plan.sourceAddress}/32 `)) &&
			(line.includes(`lookup ${plan.table}`) ||
				line.includes(`table ${plan.table}`))
		);
	});
}

export function fwmarkRuleArgv(
	action: "add" | "del",
	plan: UplinkRoutePlan,
): string[] {
	return [
		"rule",
		action,
		"priority",
		String(FWMARK_RULE_PRIORITY),
		"fwmark",
		`${hexMark(plan.mark)}/${hexMark(UPLINK_MARK_MASK)}`,
		"lookup",
		plan.table,
	];
}

export function sourceRuleArgv(
	action: "add" | "del",
	plan: UplinkRoutePlan,
): string[] {
	if (plan.sourceRulePriority === undefined) {
		throw routeUnavailable(plan.ifname, "managed source rule has no priority");
	}
	return [
		"rule",
		action,
		"priority",
		String(plan.sourceRulePriority),
		"from",
		`${plan.sourceAddress}/32`,
		"lookup",
		plan.table,
	];
}

function rulePriority(line: string): number {
	return Number.parseInt(line.trimStart().split(":", 1)[0] ?? "", 10);
}

function hexMark(mark: number): string {
	return `0x${(mark >>> 0).toString(16).padStart(8, "0")}`;
}
