import {
	parseRouteInventory,
	type readOwnedInventory,
} from "./default-route-inventory.ts";
import { type DefaultRoute, GatewayRouteError } from "./default-route-model.ts";

export type NaturalDefaults = {
	readonly key: string;
	readonly family: 4 | 6;
	readonly ifnames: readonly string[];
};

function routeIdentity(
	route: DefaultRoute,
): readonly (string | number | boolean | undefined)[] {
	return [
		route.family,
		route.ifname,
		route.gateway,
		route.source,
		route.metric,
		route.protocol,
		route.onlink,
		route.usable,
	];
}

export function naturalDefaults(
	inventory: Awaited<ReturnType<typeof readOwnedInventory>>,
): NaturalDefaults | undefined {
	if (inventory.failures.length > 0)
		throw new GatewayRouteError(
			"",
			"invalid-route",
			new AggregateError(inventory.failures),
		);
	const families = new Set(inventory.owned.map((route) => route.family));
	if (families.size !== 1) return undefined;
	const family = inventory.owned[0]?.family;
	if (family === undefined) return undefined;
	let foreignByFamily: ReadonlyMap<4 | 6, readonly DefaultRoute[]>;
	try {
		foreignByFamily = new Map(
			[...inventory.foreign].map(([family, output]) => [
				family,
				parseRouteInventory(output, family),
			]),
		);
	} catch (error) {
		if (error instanceof GatewayRouteError && error.reason === "invalid-route")
			return undefined;
		throw error;
	}
	const foreign = foreignByFamily.get(family) ?? [];
	const metric = Math.min(...foreign.map((route) => route.metric));
	const winners = foreign.filter((route) => route.metric === metric);
	if (winners.length === 0 || winners.some((route) => !route.usable))
		return undefined;
	return {
		key: JSON.stringify([
			inventory.owned.map(routeIdentity),
			[...foreignByFamily].map(([family, routes]) => [
				family,
				routes.map(routeIdentity),
			]),
		]),
		family,
		ifnames: [...new Set(winners.map((route) => route.ifname))],
	};
}
