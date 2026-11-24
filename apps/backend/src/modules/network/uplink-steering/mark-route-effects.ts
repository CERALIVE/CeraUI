import { run } from "../../../helpers/run.ts";
import {
	MANAGED_TABLE_BASE,
	markForSlot,
	slotForManagedTable,
} from "./mark-layout.ts";
import type { UplinkRouteManagerDeps } from "./route-planner.ts";
import {
	assertFwmarkPriorityAvailable,
	fwmarkRuleArgv,
	MARK_FENCE_RULE,
	parseOwnedFwmarkRules,
	parseSteeringSourceRules,
	sourceRuleArgv,
	withoutMarkFence,
} from "./route-policy.ts";
import { flushRouteTable } from "./route-table-ownership.ts";

const defaultDeps: UplinkRouteManagerDeps = { run };

export async function ensureMarkFence(
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<void> {
	const output = await deps.run("ip", ["rule", "show"]);
	assertFwmarkPriorityAvailable(withoutMarkFence(output), "uplink-steering");
	if (!MARK_FENCE_RULE.test(output)) {
		await deps.run("ip", [
			"rule",
			"add",
			"priority",
			"110",
			"fwmark",
			"0xca000000/0xff000000",
			"lookup",
			"30000",
		]);
	}
}

export async function retireMarkSupport(
	mark: number,
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<void> {
	const table = String(MANAGED_TABLE_BASE + ((mark >>> 8) & 0xffff));
	const output = await deps.run("ip", ["rule", "show"]);
	for (const owned of parseOwnedFwmarkRules(output)) {
		if (owned.mark !== mark) continue;
		await deps.run("ip", fwmarkRuleArgv("del", owned));
	}
	for (const source of parseSteeringSourceRules(output)) {
		if (source.table !== table) continue;
		await deps.run(
			"ip",
			sourceRuleArgv("del", {
				...source,
				ifname: "uplink-steering",
				sourceRulePriority: source.priority,
			}),
		);
	}
	await flushRouteTable(deps, table);
}

export async function discoverMarkInventory(
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<ReadonlySet<number>> {
	const rules = await deps.run("ip", ["rule", "show"]);
	const routes = await deps.run("ip", [
		"-o",
		"-4",
		"route",
		"show",
		"table",
		"all",
	]);
	const tables = [
		...parseSteeringSourceRules(rules).map(({ table }) => table),
		...Array.from(
			routes.matchAll(/\btable (\d+)(?:\s|$)/g),
			(match) => match[1] ?? "",
		),
	];
	const inventory = new Set(
		parseOwnedFwmarkRules(rules).map(({ mark }) => mark),
	);
	for (const table of tables) {
		const slot = slotForManagedTable(table);
		if (slot !== undefined) inventory.add(markForSlot(slot));
	}
	return inventory;
}
