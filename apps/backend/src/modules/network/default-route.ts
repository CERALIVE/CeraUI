import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import {
	type DefaultRoute,
	GatewayRouteError,
	preferenceRoute,
	readDefaultRoutes,
	samePreference,
} from "./default-route-model.ts";

export {
	GatewayRouteError,
	HOST_ROUTE_PROTOCOL,
} from "./default-route-model.ts";

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

const pending = new WeakMap<typeof run, Promise<void>>();

async function readRoutes(
	args: string[],
	deps: GwDeps,
): Promise<DefaultRoute[]> {
	const output = await deps.runner("ip", args);
	try {
		return readDefaultRoutes(output, deps.family);
	} catch (error) {
		if (error instanceof GatewayRouteError)
			logParseError(
				parseFail(
					"parseDefaultRouteLine",
					"invalid default-route output",
					output,
				),
			);
		throw error;
	}
}

export async function setDefaultRoute(
	goodIf: string | undefined,
	deps: Partial<GwDeps> = {},
): Promise<void> {
	const runner = deps.runner ?? run;
	const ifname = goodIf === undefined ? undefined : argMatch(ID_RE, goodIf);
	const flight = (pending.get(runner) ?? Promise.resolve()).then(() =>
		reconcilePreference(ifname, { runner, family: deps.family ?? 4 }),
	);
	// Failed transactions do not poison the serialization tail; callers keep the error.
	pending.set(
		runner,
		flight.catch(() => undefined),
	);
	return flight;
}

async function desiredPreference(
	ifname: string,
	baseline: readonly DefaultRoute[],
	deps: GwDeps,
): Promise<DefaultRoute | undefined> {
	const familyRoutes = baseline.filter((route) => route.family === deps.family);
	const existing = familyRoutes
		.filter((route) => route.ifname === ifname)
		.sort((a, b) => a.metric - b.metric)[0];
	const fallback = existing
		? []
		: await readRoutes(
				[
					...(deps.family === 6 ? ["-6"] : []),
					"-N",
					"route",
					"show",
					"table",
					ifname,
					"default",
				],
				deps,
			);
	if (fallback.length > 1) throw new GatewayRouteError(ifname, "invalid-route");
	const selected = existing ?? fallback[0];
	if (!selected) {
		logParseError(
			parseFail(
				"parseDefaultRouteLine",
				"candidate has no usable default route",
				"",
			),
		);
		throw new GatewayRouteError(ifname, "invalid-route");
	}
	if (
		selected.ifname !== ifname ||
		selected.owned ||
		selected.tokens.includes("linkdown")
	)
		throw new GatewayRouteError(ifname, "invalid-route");
	const lowest = Math.min(
		...familyRoutes
			.filter((route) => route.ifname !== ifname)
			.map((route) => route.metric),
	);
	if (existing && selected.metric < lowest) return undefined;
	const metric = Number.isFinite(lowest) ? lowest - 1 : selected.metric;
	// IPv6 normalizes metric zero to 1024; it cannot represent a lower preference.
	if (metric < (deps.family === 6 ? 1 : 0))
		throw new GatewayRouteError(ifname, "metric-exhausted");
	return preferenceRoute(selected, metric);
}

async function reconcilePreference(
	ifname: string | undefined,
	deps: GwDeps,
): Promise<void> {
	const previous: DefaultRoute[] = [];
	for (const family of [4, 6] as const)
		previous.push(
			...(await readRoutes(
				[...(family === 6 ? ["-6"] : []), "-N", "route", "show", "default"],
				{ ...deps, family },
			)),
		);
	const owned = previous.filter((route) => route.owned);
	const desired =
		ifname === undefined
			? undefined
			: await desiredPreference(
					ifname,
					previous.filter((route) => !route.owned),
					deps,
				);
	const retained = desired
		? owned.find((route) => samePreference(route, desired))
		: undefined;
	const undo: { readonly verb: "add" | "del"; readonly route: DefaultRoute }[] =
		[];
	const mutate = (verb: "add" | "del", route: DefaultRoute) =>
		deps.runner("ip", [
			...(route.family === 6 ? ["-6"] : []),
			"route",
			verb,
			...route.tokens,
		]);
	try {
		for (const route of owned) {
			if (route === retained) continue;
			await mutate("del", route);
			undo.push({ verb: "add", route });
		}
		if (desired && !retained) {
			await mutate("add", desired);
			undo.push({ verb: "del", route: desired });
		}
	} catch (error) {
		const failures: unknown[] = [error];
		for (const { verb, route } of undo.reverse()) {
			try {
				await mutate(verb, route);
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
		}
		throw new GatewayRouteError(
			ifname ?? "",
			"apply-failed",
			new AggregateError(failures),
		);
	}
	if (undo.length > 0)
		logger.info("Host default-route preference reconciled", {
			ifname,
			family: deps.family,
			metric: desired?.metric,
			removed: owned.length - Number(Boolean(retained)),
		});
}
