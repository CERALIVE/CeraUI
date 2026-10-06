import { logger } from "../../helpers/logger.ts";
import { fibChoosesPreference } from "./default-route-acquisition.ts";
import type { GwDeps } from "./default-route-inventory.ts";
import {
	type DefaultRoute,
	GatewayRouteError,
	ownedRouteTokens,
	samePreference,
} from "./default-route-model.ts";

type Mutation = {
	readonly verb: "add" | "prepend" | "del";
	readonly route: DefaultRoute;
};

export async function applyPreference(
	owned: readonly DefaultRoute[],
	desired: DefaultRoute | undefined,
	deps: GwDeps,
): Promise<void> {
	const identical = desired
		? owned.find((route) => samePreference(route, desired) && route.usable)
		: undefined;
	const retained =
		identical &&
		(!identical.prepend || (await fibChoosesPreference(identical, deps)))
			? identical
			: undefined;
	const undo: Mutation[] = [];
	const addVerb = (route: DefaultRoute) => (route.prepend ? "prepend" : "add");
	const mutate = ({ verb, route }: Mutation) =>
		deps.runner("ip", [
			...(route.family === 6 ? ["-6"] : []),
			"route",
			verb,
			...ownedRouteTokens(route),
		]);
	try {
		for (const route of owned) {
			if (route === retained) continue;
			await mutate({ verb: "del", route });
			undo.push({ verb: addVerb(route), route });
		}
		if (desired && !retained) {
			await mutate({ verb: addVerb(desired), route: desired });
			undo.push({ verb: "del", route: desired });
			if (desired.prepend && !(await fibChoosesPreference(desired, deps)))
				throw new GatewayRouteError(desired.ifname, "apply-failed");
		}
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
	if (undo.length > 0)
		logger.info("Host default-route preference reconciled", {
			ifname: desired?.ifname,
			family: deps.family,
			metric: desired?.metric,
			removed: owned.length - Number(Boolean(retained)),
		});
}
