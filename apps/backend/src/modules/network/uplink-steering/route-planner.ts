import { isFibTableAbsent } from "../../../helpers/iproute2-absent.ts";
import { argMatch, ID_RE, run } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import type { UplinkRoutePlan } from "./applier.ts";
import { SOURCE_ROUTE_RULE_PRIORITY } from "./contracts.ts";
import { isManagedUplinkTable } from "./mark-layout.ts";
import { asRouteError, routeUnavailable } from "./route-errors.ts";
import {
	managedPlanFromRoute,
	managedTable,
	planManagedRoute,
	planTwinRoute,
} from "./route-managed-plan.ts";
import {
	isEthernetUplinkIface,
	parseHasDefaultRoute,
	parseIpRules,
} from "./route-parsers.ts";
import {
	assertFwmarkPriorityAvailable,
	withoutMarkFence,
} from "./route-policy.ts";

export { isManagedUplinkTable } from "./mark-layout.ts";

const SAFE_TABLE_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export interface UplinkRouteCandidate {
	readonly identity: string;
	readonly ifname: string;
	readonly sourceAddress: string;
	readonly sourceAddressUnique: boolean;
	readonly mark: number;
}

export interface UplinkRouteManagerDeps {
	run: typeof run;
	readonly journaled?: boolean;
}

const defaultDeps: UplinkRouteManagerDeps = { run };

export async function readRouteTable(
	deps: UplinkRouteManagerDeps,
	table: string,
): Promise<string> {
	try {
		return await deps.run("ip", ["route", "show", "table", table]);
	} catch (error) {
		if (isFibTableAbsent(error, "read")) return "";
		throw error;
	}
}

export async function planUplinkRoute(
	candidate: UplinkRouteCandidate,
	deps: UplinkRouteManagerDeps = defaultDeps,
): Promise<UplinkRoutePlan> {
	try {
		return await planUplinkRouteInner(candidate, deps);
	} catch (error) {
		throw asRouteError(candidate.ifname, error);
	}
}

async function planUplinkRouteInner(
	candidate: UplinkRouteCandidate,
	deps: UplinkRouteManagerDeps,
): Promise<UplinkRoutePlan> {
	assertCandidate(candidate);
	const ruleOutput = await deps.run("ip", ["rule", "show"]);
	assertFwmarkPriorityAvailable(
		deps.journaled ? withoutMarkFence(ruleOutput) : ruleOutput,
		candidate.ifname,
	);
	if (!candidate.sourceAddressUnique)
		return await planTwinRoute(candidate, deps);
	const rules = parseIpRules(ruleOutput);
	if (rules === null) {
		throw routeUnavailable(candidate.ifname, "ip rule output was unparseable");
	}
	const tables = new Set(
		rules
			.filter(
				(rule) =>
					rule.src === candidate.sourceAddress ||
					rule.src === `${candidate.sourceAddress}/32`,
			)
			.map((rule) => rule.table)
			.filter(
				(table) =>
					table === managedTable(candidate.mark) ||
					!isManagedUplinkTable(table),
			),
	);
	if (tables.size > 1) {
		throw routeUnavailable(
			candidate.ifname,
			"source address selects several tables",
		);
	}
	const [existingTable] = tables;
	if (existingTable === undefined)
		return await planWithoutSourceRule(candidate, deps);
	assertTable(existingTable);
	const managed = existingTable === managedTable(candidate.mark);
	if (managed) {
		const liveDefault = await deps.run("ip", [
			"-4",
			"route",
			"show",
			"default",
			"dev",
			argMatch(ID_RE, candidate.ifname),
		]);
		if (liveDefault.trim() !== "") {
			return managedPlanFromRoute(
				candidate,
				existingTable,
				liveDefault,
				SOURCE_ROUTE_RULE_PRIORITY,
				true,
			);
		}
	}
	const routeOutput = await readRouteTable(deps, existingTable);
	if (
		parseHasDefaultRoute(routeOutput) &&
		parseDefaultRouteInterface(routeOutput) === candidate.ifname
	) {
		if (managed) {
			return managedPlanFromRoute(
				candidate,
				existingTable,
				routeOutput,
				SOURCE_ROUTE_RULE_PRIORITY,
				false,
			);
		}
		return { ...candidate, table: existingTable, managed: false };
	}
	if (isModuleProvisionedUplink(candidate.ifname)) {
		return await planManagedRoute(candidate, deps, undefined);
	}
	throw routeUnavailable(
		candidate.ifname,
		`table ${existingTable} has no usable default`,
	);
}

async function planWithoutSourceRule(
	candidate: UplinkRouteCandidate,
	deps: UplinkRouteManagerDeps,
): Promise<UplinkRoutePlan> {
	// Image PR #115 retired dispatcher source rules; steering owns every class.
	return await planManagedRoute(candidate, deps, SOURCE_ROUTE_RULE_PRIORITY);
}

function assertCandidate(candidate: UplinkRouteCandidate): void {
	argMatch(ID_RE, candidate.ifname);
	if (!IPV4_RE.test(candidate.sourceAddress)) {
		throw routeUnavailable(candidate.ifname, "source address was invalid");
	}
	if (typeof candidate.sourceAddressUnique !== "boolean") {
		throw routeUnavailable(
			candidate.ifname,
			"source address uniqueness was unknown",
		);
	}
}

function assertTable(table: string): void {
	if (!SAFE_TABLE_RE.test(table)) {
		throw routeUnavailable(table, "routing table token was unsafe");
	}
}

export function isModuleProvisionedUplink(ifname: string): boolean {
	return isEthernetUplinkIface(ifname) || /^(?:ww|ppp)/.test(ifname);
}
