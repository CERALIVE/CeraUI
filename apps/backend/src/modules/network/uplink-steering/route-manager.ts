import { isFibTableAbsent } from "../../../helpers/iproute2-absent.ts";
import { run } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import { parseDefaultRouteLine } from "../gateways.ts";
import type { RouteProvisioning, UplinkRoutePlan } from "./applier.ts";
import { asRouteError, routeUnavailable } from "./route-errors.ts";
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
	let replacedTableRoute: readonly string[] | undefined;
	let addedTableRoute: readonly string[] | undefined;
	try {
		if (plan.managed) {
			const routeOutput = await readRouteTable(deps, plan.table);
			const defaultLine =
				routeOutput
					.split("\n")
					.find((line) => line.trim().startsWith("default")) ?? "";
			const currentRoute = parseDefaultRouteLine(defaultLine);
			const sameDevice =
				parseDefaultRouteInterface(defaultLine) === plan.ifname;
			const plannedRoute = plan.defaultRouteArgv;
			const changedFields =
				currentRoute.ok && plannedRoute !== undefined
					? ["via", "proto", "metric"].filter((field) => {
							const currentIndex = currentRoute.value.indexOf(field);
							const plannedIndex = plannedRoute.indexOf(field);
							const current =
								currentIndex === -1
									? undefined
									: currentRoute.value[currentIndex + 1];
							const planned =
								plannedIndex === -1
									? undefined
									: plannedRoute[plannedIndex + 1];
							return field === "metric"
								? (current ?? "0") !== (planned ?? "0")
								: current !== planned;
						})
					: [];
			if (!sameDevice || changedFields.length > 0) {
				if (plannedRoute === undefined) {
					throw routeUnavailable(
						plan.ifname,
						"managed route has no replacement argv",
					);
				}
				if (sameDevice && currentRoute.ok) {
					const metricChanged = changedFields.includes("metric");
					const previousRoute = [
						"route",
						metricChanged ? "add" : "replace",
						"table",
						plan.table,
						...currentRoute.value.slice(2),
					];
					// A different metric is a distinct kernel route key.
					if (metricChanged) {
						const replacementRoute = ["route", "add", ...plannedRoute.slice(2)];
						await deps.run("ip", replacementRoute);
						addedTableRoute = replacementRoute;
						await deps.run("ip", ["route", "del", ...previousRoute.slice(2)]);
					} else {
						await deps.run("ip", [...plannedRoute]);
					}
					replacedTableRoute = previousRoute;
				} else {
					await deps.run("ip", [...plannedRoute]);
					createdTableRoute = true;
				}
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
			replacedTableRoute,
			addedTableRoute,
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
		replacedTableRoute,
		addedTableRoute,
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
	if (provisioning.replacedTableRoute !== undefined) {
		await deps.run("ip", [...provisioning.replacedTableRoute]);
	}
	if (provisioning.addedTableRoute !== undefined) {
		await deps.run("ip", [
			"route",
			"del",
			...provisioning.addedTableRoute.slice(2),
		]);
	} else if (provisioning.createdTableRoute) {
		await flushRouteTable(deps, route.table);
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
			await flushRouteTable(deps, plan.table);
		}
	} catch (error) {
		throw asRouteError(plan.ifname, error);
	}
}

async function flushRouteTable(
	deps: UplinkRouteManagerDeps,
	table: string,
): Promise<void> {
	try {
		await deps.run("ip", ["route", "flush", "table", table]);
	} catch (error) {
		if (!isFibTableAbsent(error, "flush")) throw error;
	}
}

function buildProvisioning(
	route: UplinkRoutePlan,
	createdTableRoute: boolean,
	createdSourceRule: boolean,
	createdFwmarkRule: boolean,
	replacedTableRoute: readonly string[] | undefined,
	addedTableRoute: readonly string[] | undefined,
): RouteProvisioning {
	return {
		route,
		changed:
			createdTableRoute ||
			createdSourceRule ||
			createdFwmarkRule ||
			replacedTableRoute !== undefined ||
			addedTableRoute !== undefined,
		createdTableRoute,
		createdSourceRule,
		createdFwmarkRule,
		...(replacedTableRoute === undefined ? {} : { replacedTableRoute }),
		...(addedTableRoute === undefined ? {} : { addedTableRoute }),
	};
}
