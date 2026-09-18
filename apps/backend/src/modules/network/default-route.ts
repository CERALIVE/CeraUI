import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import { parseDefaultRouteInterface } from "./connectivity-candidates.ts";

export function buildRouteAddArgv(gw: string): string[] {
	const tokens = gw
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	return ["route", "add", ...tokens];
}

export function parseDefaultRouteLine(gw: string): ParseResult<string[]> {
	const tokens = gw
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (tokens[0] !== "default") {
		return parseFail(
			"parseDefaultRouteLine",
			"route line does not start with 'default'",
			gw,
		);
	}
	if (!tokens.includes("via") && !tokens.includes("dev")) {
		return parseFail(
			"parseDefaultRouteLine",
			"route line has neither a 'via' nor a 'dev' clause",
			gw,
		);
	}
	return parseOk(buildRouteAddArgv(gw));
}

export type GwDeps = {
	readonly runner: typeof run;
	readonly family: 4 | 6;
};

export class GatewayRouteError extends Error {
	readonly name = "GatewayRouteError";
	constructor(
		readonly ifname: string,
		readonly reason: "invalid-route" | "apply-failed",
		cause?: unknown,
	) {
		super(`setDefaultRoute: ${reason} via ${ifname}`, { cause });
	}
}

function routeMetric(route: readonly string[], ifname: string): number {
	const index = route.indexOf("metric");
	const value = index < 0 ? 0 : Number(route[index + 1]);
	if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new GatewayRouteError(ifname, "invalid-route");
	}
	return value;
}

export async function setDefaultRoute(
	goodIf: string,
	deps: Partial<GwDeps> = {},
): Promise<void> {
	const runner = deps.runner ?? run;
	const ifname = argMatch(ID_RE, goodIf);
	const familyArgs = deps.family === 6 ? ["-6"] : [];
	const previous = (
		await runner("ip", [...familyArgs, "route", "show", "default"])
	)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	// DHCP main-table defaults exist even when the legacy named table does not.
	const existing = previous.find(
		(line) => parseDefaultRouteInterface(line) === ifname,
	);
	const gw =
		existing ??
		(await runner("ip", [
			...familyArgs,
			"route",
			"show",
			"table",
			ifname,
			"default",
		]));
	const parsed = parseDefaultRouteLine(gw);
	if (!parsed.ok) {
		logParseError(parsed);
		throw new GatewayRouteError(ifname, "invalid-route", parsed.reason);
	}
	if (gw.trim().includes("\n") || parseDefaultRouteInterface(gw) !== ifname) {
		throw new GatewayRouteError(ifname, "invalid-route");
	}
	const priorRoutes = previous.map((line) => {
		const prior = parseDefaultRouteLine(line);
		if (!prior.ok)
			throw new GatewayRouteError(ifname, "invalid-route", prior.reason);
		return prior.value.slice(2);
	});
	const selected = parsed.value.slice(2);
	const selectedMetric = routeMetric(selected, ifname);
	const metrics = priorRoutes.map((route) => routeMetric(route, ifname));
	const ceiling = Math.max(selectedMetric, ...metrics);
	const competitors = priorRoutes.filter(
		(route) =>
			route.join(" ") !== selected.join(" ") &&
			routeMetric(route, ifname) <= selectedMetric,
	);
	if (ceiling + competitors.length > 0xffff_ffff) {
		throw new GatewayRouteError(ifname, "invalid-route");
	}
	const undo: string[][] = [];
	try {
		if (existing === undefined) {
			await runner("ip", [...familyArgs, ...parsed.value]);
			undo.push(["route", "del", ...selected]);
		}
		for (const [index, route] of competitors.entries()) {
			const metricIndex = route.indexOf("metric");
			const demoted = route.filter(
				(_, i) =>
					metricIndex < 0 || (i !== metricIndex && i !== metricIndex + 1),
			);
			demoted.push("metric", String(ceiling + index + 1));
			// Keep every NIC routable for its next bound probe. Add before removing.
			await runner("ip", [...familyArgs, "route", "add", ...demoted]);
			undo.push(["route", "del", ...demoted]);
			await runner("ip", [...familyArgs, "route", "del", ...route]);
			undo.push(["route", "add", ...route]);
		}
	} catch (error) {
		const failures: unknown[] = [error];
		for (const args of undo.reverse()) {
			try {
				await runner("ip", [...familyArgs, ...args]);
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
		}
		throw new GatewayRouteError(
			ifname,
			"apply-failed",
			new AggregateError(failures),
		);
	}
	logger.info("Host default-route preference applied", {
		ifname,
		family: deps.family ?? 4,
		demoted: competitors.length,
	});
}
