import { isIP } from "node:net";
import { argMatch, ID_RE } from "../../helpers/run.ts";

// Reserved for CeraUI host preferences, never NM/DHCP or the UID-pin tables.
export const HOST_ROUTE_PROTOCOL = "242";

export class GatewayRouteError extends Error {
	override readonly name = "GatewayRouteError";
	constructor(
		readonly ifname: string,
		readonly reason: "invalid-route" | "apply-failed" | "metric-exhausted",
		cause?: unknown,
	) {
		super(`setDefaultRoute: ${reason} via ${ifname}`, { cause });
	}
}

export type DefaultRoute = {
	readonly family: 4 | 6;
	readonly tokens: readonly string[];
	readonly ifname: string;
	readonly metric: number;
	readonly owned: boolean;
};

export function readDefaultRoutes(
	output: string,
	family: 4 | 6,
): DefaultRoute[] {
	return output
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const tokens = line.trim().split(/\s+/);
			const ifname = tokens[tokens.indexOf("dev") + 1];
			if (
				tokens[0] !== "default" ||
				!tokens.includes("dev") ||
				!ifname ||
				tokens.includes("nexthop") ||
				tokens.includes("from")
			)
				throw new GatewayRouteError("", "invalid-route");
			argMatch(ID_RE, ifname);
			const metricIndex = tokens.indexOf("metric");
			const metric =
				metricIndex < 0
					? family === 6
						? 1024
						: 0
					: Number(tokens[metricIndex + 1]);
			if (!Number.isInteger(metric) || metric < 0 || metric > 0xffff_ffff)
				throw new GatewayRouteError(ifname, "invalid-route");
			return {
				family,
				tokens,
				ifname,
				metric,
				owned: tokens[tokens.indexOf("proto") + 1] === HOST_ROUTE_PROTOCOL,
			};
		});
}

export function preferenceRoute(
	source: DefaultRoute,
	metric: number,
): DefaultRoute {
	const tokens = ["default"];
	for (const key of ["via", "dev", "src"] as const) {
		const index = source.tokens.indexOf(key);
		if (index < 0) continue;
		const value = source.tokens[index + 1];
		if (!value || (key !== "dev" && isIP(value) !== source.family))
			throw new GatewayRouteError(source.ifname, "invalid-route");
		tokens.push(key, value);
	}
	if (source.tokens.includes("onlink")) tokens.push("onlink");
	tokens.push("proto", HOST_ROUTE_PROTOCOL, "metric", String(metric));
	return { ...source, tokens, metric, owned: true };
}

export function samePreference(a: DefaultRoute, b: DefaultRoute): boolean {
	return (
		a.family === b.family &&
		a.ifname === b.ifname &&
		a.metric === b.metric &&
		["via", "src"].every(
			(key) =>
				a.tokens[a.tokens.indexOf(key) + 1] ===
				b.tokens[b.tokens.indexOf(key) + 1],
		) &&
		a.tokens.includes("onlink") === b.tokens.includes("onlink")
	);
}
