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
	readonly removedTableRoutes?: readonly (readonly string[])[];
}

function routeField(
	route: readonly string[],
	field: string,
): string | undefined {
	const index = route.indexOf(field);
	return index === -1 ? undefined : route[index + 1];
}

function routeTos(route: readonly string[]): number {
	return Number(routeField(route, "tos") ?? routeField(route, "dsfield") ?? 0);
}

function routeKey(route: readonly string[]): string {
	const typed = ["blackhole", "unreachable", "prohibit", "throw"].includes(
		route[0] ?? "",
	);
	return JSON.stringify([
		route[typed ? 1 : 0],
		routeTos(route),
		Number(routeField(route, "metric") ?? 0),
	]);
}

export async function ensureManagedTableRoute(
	plan: UplinkRoutePlan,
	deps: UplinkRouteManagerDeps,
): Promise<TableChanges> {
	let createdTableRoute = false;
	let replacedTableRoute: readonly string[] | undefined;
	let addedTableRoute: readonly string[] | undefined;
	const removedTableRoutes: string[][] = [];
	const changes = (): TableChanges => ({
		createdTableRoute,
		...(replacedTableRoute === undefined ? {} : { replacedTableRoute }),
		...(addedTableRoute === undefined ? {} : { addedTableRoute }),
		...(removedTableRoutes.length === 0 ? {} : { removedTableRoutes }),
	});
	try {
		if (plan.managed) {
			const routeOutput = await readRouteTable(deps, plan.table);
			const lines = routeOutput
				.split("\n")
				.map((line) =>
					line
						.trim()
						.split(/\s+/)
						.filter(
							(token) =>
								token !== "" &&
								![
									"linkdown",
									"dead",
									"pervasive",
									"offload",
									"trap",
									"rt_offload",
									"rt_trap",
									"rt_offload_failed",
								].includes(token),
						),
				)
				.filter((line) => line.length > 0);
			const planned = plan.defaultRouteArgv?.slice(4);
			const [only] = lines;
			if (
				lines.length > 0 &&
				!(
					lines.length === 1 &&
					only?.[0] === "default" &&
					routeTos(only) === routeTos(planned ?? [])
				)
			) {
				if (planned === undefined) {
					throw routeUnavailable(
						plan.ifname,
						"managed route has no replacement argv",
					);
				}
				const key = routeKey(planned);
				const consumed = lines.find((line) => routeKey(line) === key);
				const isPlanned = (line: readonly string[]) =>
					routeKey(line) === key &&
					line[0] === planned[0] &&
					["dev", "via", "proto"].every(
						(field) => routeField(line, field) === routeField(planned, field),
					);
				if (!lines.some(isPlanned)) {
					await deps.run("ip", [
						"route",
						consumed === undefined ? "add" : "replace",
						"table",
						plan.table,
						...planned,
					]);
					if (consumed === undefined) {
						addedTableRoute = ["route", "add", "table", plan.table, ...planned];
					} else {
						replacedTableRoute = [
							"route",
							"replace",
							"table",
							plan.table,
							...consumed,
						];
					}
				}
				for (const line of lines) {
					if (line === consumed || isPlanned(line)) continue;
					await deps.run("ip", ["route", "del", "table", plan.table, ...line]);
					removedTableRoutes.push([
						"route",
						"add",
						"table",
						plan.table,
						...line,
					]);
				}
				return changes();
			}
			const defaultLines = lines
				.map((line) => line.join(" "))
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
		| "route"
		| "createdTableRoute"
		| "replacedTableRoute"
		| "addedTableRoute"
		| "removedTableRoutes"
	>,
	deps: UplinkRouteManagerDeps,
): Promise<void> {
	const { route } = provisioning;
	for (const removed of provisioning.removedTableRoutes ?? []) {
		await deps.run("ip", [...removed]);
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
