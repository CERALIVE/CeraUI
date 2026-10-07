import { logParseError, parseFail } from "../system/cli-parse.ts";
import { type GwDeps, parseRouteInventory } from "./default-route-inventory.ts";
import {
	type DefaultRoute,
	GatewayRouteError,
	preferenceRoute,
	samePreference,
} from "./default-route-model.ts";

export async function desiredPreference(
	ifname: string,
	baseline: readonly DefaultRoute[],
	deps: GwDeps,
): Promise<DefaultRoute | undefined> {
	const existing = baseline
		.filter((route) => route.ifname === ifname)
		.sort((a, b) => a.metric - b.metric)[0];
	const fallback = existing
		? []
		: parseRouteInventory(
				await deps.runner("ip", [
					...(deps.family === 6 ? ["-6"] : []),
					"-N",
					"route",
					"show",
					"table",
					ifname,
					"default",
				]),
				deps.family,
			);
	if (fallback.length > 1) throw new GatewayRouteError(ifname, "invalid-route");
	const selected = existing ?? fallback[0];
	if (!selected)
		logParseError(
			parseFail(
				"parseDefaultRouteLine",
				"candidate has no usable default route",
				"",
			),
		);
	if (
		!selected ||
		selected.ifname !== ifname ||
		selected.owned ||
		!selected.usable
	)
		throw new GatewayRouteError(ifname, "invalid-route");
	const lowest = Math.min(
		...baseline
			.filter((route) => route.ifname !== ifname)
			.map((route) => route.metric),
	);
	if (existing && selected.metric < lowest) return undefined;
	const metric = Number.isFinite(lowest) ? lowest - 1 : selected.metric;
	if (deps.family === 6 && metric < 1)
		throw new GatewayRouteError(ifname, "metric-exhausted");
	return {
		...preferenceRoute(
			{ ...selected, realm: deps.family === 4 && lowest === 0 ? 1 : 0 },
			Math.max(0, metric),
		),
		prepend: deps.family === 4 && lowest === 0,
	};
}

export async function fibChoosesPreference(
	route: DefaultRoute,
	deps: GwDeps,
): Promise<boolean> {
	const output = await deps.runner("ip", [
		"-N",
		"route",
		"get",
		"203.0.113.254",
		"fibmatch",
	]);
	const [chosen] = parseRouteInventory(output, 4);
	const table = chosen?.tokens.indexOf("table") ?? -1;
	return (
		chosen?.owned === true &&
		(table < 0 || chosen.tokens[table + 1] === "254") &&
		chosen.usable &&
		samePreference(chosen, route)
	);
}
