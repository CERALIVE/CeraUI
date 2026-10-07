import { isIP } from "node:net";
import { argMatch, ID_RE } from "../../helpers/run.ts";

// Reserved for CeraUI host preferences, never NM/DHCP or the UID-pin tables.
export const HOST_ROUTE_PROTOCOL = "242";

export class GatewayRouteError extends Error {
	override readonly name = "GatewayRouteError";
	constructor(
		readonly ifname: string,
		readonly reason:
			| "invalid-route"
			| "apply-failed"
			| "metric-exhausted"
			| "rollback-order-unavailable",
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
	readonly realm: number;
	readonly owned: boolean;
	readonly gateway: string | undefined;
	readonly source: string | undefined;
	readonly onlink: boolean;
	readonly usable: boolean;
	readonly prepend: boolean;
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
			const realmIndex = tokens.indexOf("realm");
			const realm = realmIndex < 0 ? 0 : Number(tokens[realmIndex + 1]);
			if (!Number.isInteger(realm) || realm < 0 || realm > 0xffff)
				throw new GatewayRouteError(ifname, "invalid-route");
			const address = (key: "via" | "src") => {
				const index = tokens.indexOf(key);
				if (index < 0) return undefined;
				const value = tokens[index + 1];
				if (!value || isIP(value) !== family)
					throw new GatewayRouteError(ifname, "invalid-route");
				return value;
			};
			return {
				family,
				tokens,
				ifname,
				metric,
				realm,
				owned: tokens[tokens.indexOf("proto") + 1] === HOST_ROUTE_PROTOCOL,
				gateway: address("via"),
				source: address("src"),
				onlink: tokens.includes("onlink"),
				usable: !tokens.some(
					(token) => token === "linkdown" || token === "dead",
				),
				prepend: family === 4 && metric === 0,
			};
		});
}

export function preferenceRoute(
	source: DefaultRoute,
	metric: number,
): DefaultRoute {
	const route = { ...source, metric, owned: true };
	return { ...route, tokens: ownedRouteTokens(route) };
}

export function ownedRouteTokens(route: DefaultRoute): string[] {
	return [
		"default",
		...(route.gateway ? ["via", route.gateway] : []),
		"dev",
		route.ifname,
		...(route.source ? ["src", route.source] : []),
		...(route.onlink ? ["onlink"] : []),
		"proto",
		HOST_ROUTE_PROTOCOL,
		"metric",
		String(route.metric),
		...(route.realm ? ["realm", String(route.realm)] : []),
	];
}

export function samePreference(a: DefaultRoute, b: DefaultRoute): boolean {
	return (
		a.family === b.family &&
		a.ifname === b.ifname &&
		a.metric === b.metric &&
		a.realm === b.realm &&
		a.gateway === b.gateway &&
		a.source === b.source &&
		a.onlink === b.onlink
	);
}
