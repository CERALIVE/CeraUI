import { isFibTableAbsent } from "../../../helpers/iproute2-absent.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import { parseDefaultRouteLine } from "../gateways.ts";
import type { RouteProvisioning, UplinkRoutePlan } from "./applier.ts";
import { routeUnavailable } from "./route-errors.ts";
import {
	readRouteTable,
	type UplinkRouteManagerDeps,
} from "./route-planner.ts";

export interface TableChanges {
	readonly createdTableRoute: boolean;
	readonly replacedTableRoute?: readonly string[];
	readonly addedTableRoute?: readonly string[];
}

export async function ensureManagedTableRoute(
	plan: UplinkRoutePlan,
	deps: UplinkRouteManagerDeps,
): Promise<TableChanges> {
	let createdTableRoute = false;
	let replacedTableRoute: readonly string[] | undefined;
	let addedTableRoute: readonly string[] | undefined;
	const changes = (): TableChanges => ({
		createdTableRoute,
		...(replacedTableRoute === undefined ? {} : { replacedTableRoute }),
		...(addedTableRoute === undefined ? {} : { addedTableRoute }),
	});
	try {
		if (plan.managed) {
			const routeOutput = await readRouteTable(deps, plan.table);
			const defaultLines = routeOutput
				.split("\n")
				.filter((line) => line.trim().startsWith("default"));
			const defaultLine = defaultLines[0] ?? "";
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
				if (
					currentRoute.ok &&
					(sameDevice ||
						(defaultLines.length === 1 &&
							!/\b(?:tos|dsfield)\b/.test(defaultLine)))
				) {
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
	} catch (error) {
		// A rejected helper cannot return the receipt for its partial writes.
		try {
			await rollbackManagedTableRoute({ route: plan, ...changes() }, deps);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"route provisioning and rollback both failed",
			);
		}
		throw error;
	}
	return changes();
}

export async function rollbackManagedTableRoute(
	provisioning: Pick<
		RouteProvisioning,
		"route" | "createdTableRoute" | "replacedTableRoute" | "addedTableRoute"
	>,
	deps: UplinkRouteManagerDeps,
): Promise<void> {
	const { route } = provisioning;
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

export async function flushRouteTable(
	deps: UplinkRouteManagerDeps,
	table: string,
): Promise<void> {
	try {
		await deps.run("ip", ["route", "flush", "table", table]);
	} catch (error) {
		if (!isFibTableAbsent(error, "flush")) throw error;
	}
}
