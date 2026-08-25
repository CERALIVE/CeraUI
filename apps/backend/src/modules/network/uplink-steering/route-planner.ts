import { argMatch, ID_RE, run } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import { parseDefaultRouteLine } from "../gateways.ts";
import {
	isEthernetUplinkIface,
	parseHasDefaultRoute,
	parseIpRules,
} from "../policy-route-check.ts";
import type { UplinkRoutePlan } from "./applier.ts";
import { SOURCE_ROUTE_RULE_PRIORITY } from "./contracts.ts";
import { asRouteError, routeUnavailable } from "./route-errors.ts";
import { assertFwmarkPriorityAvailable } from "./route-policy.ts";

const MANAGED_TABLE_BASE = 30_000;
const MANAGED_TABLE_MAX = MANAGED_TABLE_BASE + 0xffff;
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
}

const defaultDeps: UplinkRouteManagerDeps = { run };

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
	assertFwmarkPriorityAvailable(ruleOutput, candidate.ifname);
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
			.map((rule) => rule.table),
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
	const routeOutput = await deps.run("ip", [
		"route",
		"show",
		"table",
		existingTable,
	]);
	if (
		parseHasDefaultRoute(routeOutput) &&
		parseDefaultRouteInterface(routeOutput) === candidate.ifname
	) {
		if (
			isModuleProvisionedUplink(candidate.ifname) &&
			existingTable === managedTable(candidate.mark)
		) {
			return managedPlanFromRoute(
				candidate,
				existingTable,
				routeOutput,
				SOURCE_ROUTE_RULE_PRIORITY,
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
	if (!isModuleProvisionedUplink(candidate.ifname)) {
		throw routeUnavailable(candidate.ifname, "source rule is missing");
	}
	return await planManagedRoute(
		candidate,
		deps,
		candidate.sourceAddressUnique ? SOURCE_ROUTE_RULE_PRIORITY : undefined,
	);
}

async function planManagedRoute(
	candidate: UplinkRouteCandidate,
	deps: UplinkRouteManagerDeps,
	sourceRulePriority: number | undefined,
): Promise<UplinkRoutePlan> {
	const routeOutput = await deps.run("ip", [
		"-4",
		"route",
		"show",
		"default",
		"dev",
		argMatch(ID_RE, candidate.ifname),
	]);
	return managedPlanFromRoute(
		candidate,
		managedTable(candidate.mark),
		routeOutput,
		sourceRulePriority,
	);
}

function managedPlanFromRoute(
	candidate: UplinkRouteCandidate,
	table: string,
	defaultRoute: string,
	sourceRulePriority: number | undefined,
): UplinkRoutePlan {
	const defaultLine = defaultRoute
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("default"));
	if (defaultLine === undefined) {
		throw routeUnavailable(
			candidate.ifname,
			"interface has no discoverable default route",
		);
	}
	const parsed = parseDefaultRouteLine(defaultLine);
	if (
		!parsed.ok ||
		parseDefaultRouteInterface(defaultLine) !== candidate.ifname
	) {
		throw routeUnavailable(
			candidate.ifname,
			"interface default route was unusable",
		);
	}
	return {
		...candidate,
		table,
		managed: true,
		...(sourceRulePriority === undefined ? {} : { sourceRulePriority }),
		defaultRouteArgv: [
			"route",
			"replace",
			"table",
			table,
			...parsed.value.slice(2),
		],
	};
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

function managedTable(mark: number): string {
	return String(MANAGED_TABLE_BASE + ((mark >>> 8) & 0xffff));
}

export function isModuleProvisionedUplink(ifname: string): boolean {
	return isEthernetUplinkIface(ifname) || /^(?:ww|ppp)/.test(ifname);
}

export function isManagedUplinkTable(table: string): boolean {
	if (!/^\d+$/.test(table)) return false;
	const value = Number.parseInt(table, 10);
	return value >= MANAGED_TABLE_BASE && value <= MANAGED_TABLE_MAX;
}
