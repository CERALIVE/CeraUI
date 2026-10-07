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
	const identical = desired
		? owned.find((route) =>
				samePreference({ ...route, realm: desired.realm }, desired),
			)
		: undefined;
	const retained =
		identical?.usable &&
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
	const obsolete = owned
		.filter((route) => route !== retained)
		.sort(
			(a, b) =>
				Number(a.restore === undefined) - Number(b.restore === undefined),
		);
	const deferred = identical?.realm === 0 && !retained;
	const irreversible = obsolete.filter((route) => route.restore === undefined);
	if (irreversible.length > 1 || (deferred && irreversible.length > 0))
		throw new GatewayRouteError(
			desired?.ifname ?? "",
			"rollback-order-unavailable",
		);
	const replacement =
		desired && identical?.realm
			? { ...desired, realm: identical.realm === 1 ? 2 : 1 }
			: desired;
	const acquire = async () => {
		if (!replacement || retained) return;
		await mutate({ verb: addVerb(replacement), route: replacement });
		undo.push({ verb: "del", route: replacement });
		if (replacement.prepend && !(await fibChoosesPreference(replacement, deps)))
			throw new GatewayRouteError(replacement.ifname, "apply-failed");
	};
	try {
		// A distinct staged row leaves the old FIB position intact until verification passes.
		if (!deferred) await acquire();
		for (const route of obsolete) {
			await mutate({ verb: "del", route });
			if (route.restore !== undefined)
				undo.push({ verb: route.restore, route });
		}
		if (deferred) await acquire();
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
