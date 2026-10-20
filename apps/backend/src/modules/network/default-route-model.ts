import { isIP } from "node:net";
import { argMatch, ID_RE } from "../../helpers/run.ts";

// Reserved for CeraUI host preferences, never NM/DHCP or the UID-pin tables.
export const HOST_ROUTE_PROTOCOL = "242";
export const HOST_ROUTE_PROTOCOLS = [HOST_ROUTE_PROTOCOL, "243"] as const;

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
	readonly protocol: string | undefined;
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
			const realmIndex = tokens.findIndex(
				(token) => token === "realm" || token === "realms",
			);
			const realmParts =
				realmIndex < 0
					? []
					: (tokens[realmIndex + 1] ?? "").split("/").map(Number);
			if (
				(realmIndex >= 0 &&
					realmParts.length !== (tokens[realmIndex] === "realms" ? 2 : 1)) ||
				realmParts.some(
					(part) => !Number.isInteger(part) || part < 0 || part > 0xffff,
				)
			)
				throw new GatewayRouteError(ifname, "invalid-route");
			const realm =
				realmParts.length === 2
					? (realmParts[0] ?? 0) * 65536 + (realmParts[1] ?? 0)
					: (realmParts[0] ?? 0);
			const protocol = tokens.includes("proto")
				? tokens[tokens.indexOf("proto") + 1]
				: undefined;
			const owned = HOST_ROUTE_PROTOCOLS.some((value) => value === protocol);
			if (owned) {
				const keys = new Set<string>();
				for (let i = 1; i < tokens.length; i++) {
					const key = tokens[i] ?? "";
					if (keys.has(key))
						throw new GatewayRouteError(ifname, "invalid-route");
					keys.add(key);
					if (["onlink", "linkdown", "dead"].includes(key)) continue;
					if (
						![
							"via",
							"dev",
							"src",
							"proto",
							"metric",
							"realm",
							"realms",
							"scope",
							"table",
							"pref",
						].includes(key) ||
						!tokens[++i]
					)
						throw new GatewayRouteError(ifname, "invalid-route");
				}
				if (
					(keys.has("realm") && keys.has("realms")) ||
					(keys.has("pref") && tokens[tokens.indexOf("pref") + 1] !== "medium")
				)
					throw new GatewayRouteError(ifname, "invalid-route");
				if (
					keys.has("scope") &&
					!(
						tokens.includes("via")
							? ["0", "global", "universe"]
							: ["253", "link"]
					).includes(tokens[tokens.indexOf("scope") + 1] ?? "")
				)
					throw new GatewayRouteError(ifname, "invalid-route");
			}
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
				protocol,
				owned,
				gateway: address("via"),
				source: address("src"),
				onlink: tokens.includes("onlink"),
				usable: !tokens.some(
					(token) => token === "linkdown" || token === "dead",
				),
				prepend: family === 4,
			};
		});
}

export function preferenceRoute(
	source: DefaultRoute,
	metric: number,
): DefaultRoute {
	const route = {
		...source,
		metric,
		owned: true,
		protocol: HOST_ROUTE_PROTOCOL,
		realm: 0,
	};
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
		route.protocol ?? HOST_ROUTE_PROTOCOL,
		"metric",
		String(route.metric),
		...(route.realm
			? route.tokens.includes("realms")
				? ["realms", route.tokens[route.tokens.indexOf("realms") + 1] ?? ""]
				: ["realm", String(route.realm)]
			: []),
	];
}

export function samePreference(a: DefaultRoute, b: DefaultRoute): boolean {
	return (
		a.family === b.family &&
		a.ifname === b.ifname &&
		a.metric === b.metric &&
		a.realm === b.realm &&
		a.protocol === b.protocol &&
		a.gateway === b.gateway &&
		a.source === b.source &&
		a.onlink === b.onlink
	);
}
