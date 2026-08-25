import { run } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import type { RouteProvisioning, UplinkRoutePlan } from "./applier.ts";
import { asRouteError, routeUnavailable } from "./route-errors.ts";
import {
	isManagedUplinkTable,
	type UplinkRouteManagerDeps,
} from "./route-planner.ts";
import {
	assertFwmarkPriorityAvailable,
	findManagedSourceRule,
	fwmarkRuleArgv,
	hasFwmarkRule,
	hasSourceRule,
	parseOwnedFwmarkRules,
	sourceRuleArgv,
} from "./route-policy.ts";

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
			const routeOutput = await deps.run("ip", [
				"route",
				"show",
				"table",
				owned.table,
			]);
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
	let createdTableRoute = false;
	let createdSourceRule = false;
	let createdFwmarkRule = false;
	try {
		if (plan.managed) {
			const routeOutput = await deps.run("ip", [
				"route",
				"show",
				"table",
				plan.table,
			]);
			if (parseDefaultRouteInterface(routeOutput) !== plan.ifname) {
				if (plan.defaultRouteArgv === undefined) {
					throw routeUnavailable(
						plan.ifname,
						"managed route has no replacement argv",
					);
				}
				await deps.run("ip", [...plan.defaultRouteArgv]);
				createdTableRoute = true;
			}
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
			createdTableRoute,
			createdSourceRule,
			createdFwmarkRule,
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
		createdTableRoute,
		createdSourceRule,
		createdFwmarkRule,
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
	if (provisioning.createdTableRoute) {
		await deps.run("ip", ["route", "flush", "table", route.table]);
	}
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
			await deps.run("ip", ["route", "flush", "table", plan.table]);
		}
	} catch (error) {
		throw asRouteError(plan.ifname, error);
	}
}

function buildProvisioning(
	route: UplinkRoutePlan,
	createdTableRoute: boolean,
	createdSourceRule: boolean,
	createdFwmarkRule: boolean,
): RouteProvisioning {
	return {
		route,
		changed: createdTableRoute || createdSourceRule || createdFwmarkRule,
		createdTableRoute,
		createdSourceRule,
		createdFwmarkRule,
	};
}
