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
	readonly clearDefaultGws: () => Promise<void>;
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
	const gw =
		previous.find((line) => parseDefaultRouteInterface(line) === ifname) ??
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
	try {
		if (deps.clearDefaultGws) await deps.clearDefaultGws();
		else
			for (const route of priorRoutes)
				await runner("ip", [...familyArgs, "route", "del", ...route]);
		await runner("ip", [...familyArgs, ...parsed.value]);
	} catch (error) {
		const restored = await Promise.allSettled(
			priorRoutes.map((route) =>
				runner("ip", [...familyArgs, "route", "replace", ...route]),
			),
		);
		const failures = restored.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		throw new GatewayRouteError(
			ifname,
			"apply-failed",
			new AggregateError([error, ...failures]),
		);
	}
	logger.info(`Set default route: ip ${parsed.value.join(" ")}`);
}
