import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import { type ParseResult, parseFail, parseOk } from "../system/cli-parse.ts";
import { desiredPreference } from "./default-route-acquisition.ts";
import {
	type GwDeps,
	parseRouteInventory,
	readOwnedInventory,
} from "./default-route-inventory.ts";
import { applyPreference } from "./default-route-transaction.ts";

export type { GwDeps } from "./default-route-inventory.ts";

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

const pending = new WeakMap<typeof run, Promise<void>>();

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

async function reconcilePreference(
	ifname: string | undefined,
	deps: GwDeps,
): Promise<void> {
	const { owned, foreign } = await readOwnedInventory(deps.runner);
	const desired =
		ifname === undefined
			? undefined
			: await desiredPreference(
					ifname,
					parseRouteInventory(foreign.get(deps.family) ?? "", deps.family),
					deps,
				);
	await applyPreference(owned, desired, deps);
}
