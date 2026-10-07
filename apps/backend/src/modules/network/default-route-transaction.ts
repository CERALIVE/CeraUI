import { logger } from "../../helpers/logger.ts";
import { fibChoosesPreference } from "./default-route-acquisition.ts";
import type { GwDeps, OwnedDefaultRoute } from "./default-route-inventory.ts";
import {
	type DefaultRoute,
	GatewayRouteError,
	ownedRouteTokens,
	samePreference,
} from "./default-route-model.ts";

type Mutation = {
	readonly verb: "add" | "prepend" | "append" | "del";
	readonly route: DefaultRoute;
};

export async function applyPreference(
	owned: readonly OwnedDefaultRoute[],
	desired: DefaultRoute | undefined,
	deps: GwDeps,
): Promise<void> {
	const matching = desired
		? owned.filter((route) =>
				samePreference(
					{ ...route, protocol: desired.protocol, realm: 0 },
					desired,
				),
			)
		: [];
	let retained: OwnedDefaultRoute | undefined;
	for (const route of matching) {
		if (route.usable && (await fibChoosesPreference(route, deps))) {
			retained = route;
			break;
		}
	}
	const undo: Mutation[] = [];
	const addVerb = (route: DefaultRoute) => (route.prepend ? "prepend" : "add");
	const mutate = ({ verb, route }: Mutation) =>
		deps.runner("ip", [
			...(route.family === 6 ? ["-6"] : []),
			"route",
			verb,
			...ownedRouteTokens(route),
		]);
	if (!desired || retained) {
		const failures: unknown[] = [];
		const legacy = new Set(owned.filter((route) => route.realm > 0));
		for (const route of owned
			.filter((route) => route !== retained)
			.sort((a, b) => Number(b.realm > 0) - Number(a.realm > 0))) {
			try {
				if (
					route.realm === 0 &&
					[...legacy].some(
						(other) =>
							other.family === route.family &&
							other.protocol === route.protocol &&
							other.ifname === route.ifname &&
							other.gateway === route.gateway,
					)
				)
					throw new GatewayRouteError(route.ifname, "invalid-route");
				await mutate({ verb: "del", route });
				legacy.delete(route);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0)
			throw new GatewayRouteError(
				desired?.ifname ?? "",
				"apply-failed",
				new AggregateError(failures),
			);
		return;
	}
	const obsolete = owned
		.filter((route) => route !== retained)
		.sort(
			(a, b) =>
				Number(a.restore === undefined) - Number(b.restore === undefined),
		);
	const irreversible = obsolete.filter((route) => route.restore === undefined);
	if (
		irreversible.length > 1 ||
		(desired.family === 6 &&
			irreversible.some((route) => route.family === 6)) ||
		owned.some(
			(route) =>
				route.realm === 0 &&
				owned.some(
					(other) =>
						other.realm > 0 &&
						other.family === route.family &&
						other.protocol === route.protocol &&
						other.ifname === route.ifname &&
						other.gateway === route.gateway,
				),
		)
	)
		throw new GatewayRouteError(
			desired?.ifname ?? "",
			"rollback-order-unavailable",
		);
	const replacement = {
		...desired,
		protocol: matching.some((route) => route.protocol === "242")
			? "243"
			: "242",
	};
	const acquire = async () => {
		await mutate({ verb: addVerb(replacement), route: replacement });
		undo.push({ verb: "del", route: replacement });
		if (!(await fibChoosesPreference(replacement, deps)))
			throw new GatewayRouteError(replacement.ifname, "apply-failed");
	};
	const blocking = obsolete.filter(
		(route) =>
			(desired.family === 6 && route.family === 6) ||
			(route.family === desired.family &&
				route.metric < desired.metric &&
				route.restore !== undefined),
	);
	const retire = async (routes: readonly OwnedDefaultRoute[]) => {
		for (const route of routes) {
			await mutate({ verb: "del", route });
			if (route.restore !== undefined)
				undo.push({ verb: route.restore, route });
		}
	};
	try {
		// IPv4 aliases stage independently; IPv6 prepend would merge nexthops.
		await retire(blocking);
		await acquire();
		await retire(obsolete.filter((route) => !blocking.includes(route)));
	} catch (error) {
		const failures: unknown[] = [error];
		for (const mutation of undo.reverse()) {
			try {
				await mutate(mutation);
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
		}
		throw new GatewayRouteError(
			desired?.ifname ?? "",
			"apply-failed",
			new AggregateError(failures),
		);
	}
	if (undo.length > 0 || obsolete.length > 0)
		logger.info("Host default-route preference reconciled", {
			ifname: desired?.ifname,
			family: deps.family,
			metric: desired?.metric,
			removed: owned.length - Number(Boolean(retained)),
		});
}
