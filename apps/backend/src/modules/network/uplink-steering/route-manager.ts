import { run } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import type { RouteProvisioning, UplinkRoutePlan } from "./applier.ts";
import { markForSlot, slotForManagedTable } from "./mark-layout.ts";
import { asRouteError } from "./route-errors.ts";
import {
	isManagedUplinkTable,
	readRouteTable,
	type UplinkRouteManagerDeps,
} from "./route-planner.ts";
import {
	assertFwmarkPriorityAvailable,
	findManagedSourceRule,
	fwmarkRuleArgv,
	hasFwmarkRule,
	hasSourceRule,
	parseOwnedFwmarkRules,
	parseSteeringSourceRules,
	sourceRuleArgv,
} from "./route-policy.ts";
import {
	ensureManagedTableRoute,
	flushRouteTable,
	rollbackManagedTableRoute,
	type TableChanges,
} from "./route-table-ownership.ts";

export type {
	UplinkRouteCandidate,
	UplinkRouteManagerDeps,
} from "./route-planner.ts";
export {
	isManagedUplinkTable,
	isModuleProvisionedUplink,
	planUplinkRoute,
} from "./route-planner.ts";
export { hasForeignFwmarkPriorityRule, hasFwmarkRule } from "./route-policy.ts";

const defaultDeps: UplinkRouteManagerDeps = { run };

export async function discoverOwnedUplinkRoutes(
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<UplinkRoutePlan[]> {
	try {
		const rulesOutput = await deps.run("ip", ["rule", "show"]);
		const routes: UplinkRoutePlan[] = [];
		for (const owned of parseOwnedFwmarkRules(rulesOutput)) {
			const routeOutput = await readRouteTable(deps, owned.table);
			const managed = isManagedUplinkTable(owned.table);
			const sourceRule = managed
				? findManagedSourceRule(rulesOutput, owned.table)
				: undefined;
			routes.push({
				identity: `recovered:${owned.mark.toString(16)}`,
				ifname: parseDefaultRouteInterface(routeOutput) ?? "unknown0",
				sourceAddress: sourceRule?.sourceAddress ?? "0.0.0.0",
				mark: owned.mark,
				table: owned.table,
				managed,
				...(sourceRule === undefined
					? {}
					: { sourceRulePriority: sourceRule.priority }),
			});
		}
		for (const source of parseSteeringSourceRules(rulesOutput)) {
			if (
				routes.some(
					(route) =>
						route.table === source.table &&
						route.sourceAddress === source.sourceAddress &&
						route.sourceRulePriority === source.priority,
				)
			)
				continue;
			const slot = slotForManagedTable(source.table);
			if (slot === undefined) continue;
			const mark = markForSlot(slot);
			routes.push({
				identity: `recovered:${mark.toString(16)}`,
				ifname: "unknown0",
				sourceAddress: source.sourceAddress,
				mark,
				table: source.table,
				managed: true,
				sourceRulePriority: source.priority,
			});
		}
		return routes;
	} catch (error) {
		throw asRouteError("uplink-steering", error);
	}
}

export async function ensureUplinkRoute(
	plan: UplinkRoutePlan,
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<RouteProvisioning> {
	try {
		return await ensureUplinkRouteInner(plan, deps);
	} catch (error) {
		throw asRouteError(plan.ifname, error);
	}
}

async function ensureUplinkRouteInner(
	plan: UplinkRoutePlan,
	deps: UplinkRouteManagerDeps,
): Promise<RouteProvisioning> {
	const rules = await deps.run("ip", ["rule", "show"]);
	assertFwmarkPriorityAvailable(rules, plan.ifname);
	let tableChanges: TableChanges = { createdTableRoute: false };
	let createdSourceRule = false;
	let createdFwmarkRule = false;
	const removedSourceRules: UplinkRoutePlan[] = [];
	try {
		tableChanges = await ensureManagedTableRoute(plan, deps);
		for (const source of plan.managed ? parseSteeringSourceRules(rules) : []) {
			const staleSource =
				source.sourceAddress === plan.sourceAddress &&
				source.table !== plan.table;
			const staleTable =
				source.table === plan.table &&
				(source.sourceAddress !== plan.sourceAddress ||
					plan.sourceRulePriority === undefined);
			if (!staleSource && !staleTable) continue;
			const stale = {
				...plan,
				table: source.table,
				sourceAddress: source.sourceAddress,
				sourceRulePriority: source.priority,
			};
			await deps.run("ip", sourceRuleArgv("del", stale));
			removedSourceRules.push(stale);
		}
		if (plan.sourceRulePriority !== undefined && !hasSourceRule(rules, plan)) {
			await deps.run("ip", sourceRuleArgv("add", plan));
			createdSourceRule = true;
		}
		if (!hasFwmarkRule(rules, plan)) {
			await deps.run("ip", fwmarkRuleArgv("add", plan));
			createdFwmarkRule = true;
		}
	} catch (error) {
		const provisioning = buildProvisioning(
			plan,
			tableChanges,
			createdSourceRule,
			createdFwmarkRule,
			removedSourceRules,
		);
		try {
			await rollbackUplinkRoute(provisioning, deps);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"route provisioning and rollback both failed",
			);
		}
		throw error;
	}
	return buildProvisioning(
		plan,
		tableChanges,
		createdSourceRule,
		createdFwmarkRule,
		removedSourceRules,
	);
}

export async function rollbackUplinkRoute(
	provisioning: RouteProvisioning,
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<void> {
	const { route } = provisioning;
	if (provisioning.createdFwmarkRule) {
		await deps.run("ip", fwmarkRuleArgv("del", route));
	}
	if (provisioning.createdSourceRule) {
		await deps.run("ip", sourceRuleArgv("del", route));
	}
	for (const source of provisioning.removedSourceRules ?? []) {
		await deps.run("ip", sourceRuleArgv("add", source));
	}
	await rollbackManagedTableRoute(provisioning, deps);
}

export async function removeUplinkRoute(
	plan: UplinkRoutePlan,
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<void> {
	try {
		const rules = await deps.run("ip", ["rule", "show"]);
		if (hasFwmarkRule(rules, plan)) {
			await deps.run("ip", fwmarkRuleArgv("del", plan));
		}
		if (hasSourceRule(rules, plan)) {
			await deps.run("ip", sourceRuleArgv("del", plan));
		}
		if (plan.managed) {
			await flushRouteTable(deps, plan.table);
		}
	} catch (error) {
		throw asRouteError(plan.ifname, error);
	}
}

function buildProvisioning(
	route: UplinkRoutePlan,
	tableChanges: TableChanges,
	createdSourceRule: boolean,
	createdFwmarkRule: boolean,
	removedSourceRules: readonly UplinkRoutePlan[],
): RouteProvisioning {
	const { createdTableRoute, replacedTableRoute, addedTableRoute } =
		tableChanges;
	return {
		route,
		changed:
			createdTableRoute ||
			createdSourceRule ||
			createdFwmarkRule ||
			removedSourceRules.length > 0 ||
			replacedTableRoute !== undefined ||
			addedTableRoute !== undefined,
		createdTableRoute,
		createdSourceRule,
		createdFwmarkRule,
		...(replacedTableRoute === undefined ? {} : { replacedTableRoute }),
		...(addedTableRoute === undefined ? {} : { addedTableRoute }),
		...(removedSourceRules.length === 0 ? {} : { removedSourceRules }),
	};
}
