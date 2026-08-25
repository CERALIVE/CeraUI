import type {
	ShareRulesetState,
	SteeringUplink,
	UplinkFlowsResetEvent,
} from "./contracts.ts";
import { buildShareRuleset } from "./ruleset.ts";

export interface UplinkRoutePlan {
	readonly identity: string;
	readonly ifname: string;
	readonly sourceAddress: string;
	readonly mark: number;
	readonly table: string;
	readonly managed: boolean;
	readonly sourceRulePriority?: number;
	readonly defaultRouteArgv?: readonly string[];
}

export interface PreparedSteeringState extends ShareRulesetState {
	readonly routes: readonly UplinkRoutePlan[];
}

export interface RouteProvisioning {
	readonly route: UplinkRoutePlan;
	readonly changed: boolean;
	readonly createdFwmarkRule?: boolean;
	readonly createdSourceRule?: boolean;
	readonly createdTableRoute?: boolean;
}

export interface UplinkSteeringApplierDeps {
	discoverRoutes(): Promise<readonly UplinkRoutePlan[]>;
	ensureRoute(route: UplinkRoutePlan): Promise<RouteProvisioning>;
	rollbackRoute(provisioning: RouteProvisioning): Promise<void>;
	removeRoute(route: UplinkRoutePlan): Promise<void>;
	applyRuleset(ruleset: string, mode: "activate" | "reload"): Promise<void>;
	deactivateSharing(): Promise<void>;
	flushConntrack(mark: number): Promise<void>;
	setIpForwarding(enabled: boolean): Promise<void>;
	publishFlowsReset(event: UplinkFlowsResetEvent): void;
}

export class UplinkSteeringApplier {
	readonly #deps: UplinkSteeringApplierDeps;

	constructor(deps: UplinkSteeringApplierDeps) {
		this.#deps = deps;
	}

	async apply(
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	): Promise<void> {
		const provisioned: RouteProvisioning[] = [];
		const removedSupport: UplinkRoutePlan[] = [];
		const wasActive = (previous?.clientZones.length ?? 0) > 0;
		const isActive = next.clientZones.length > 0;
		let activatedService = false;
		let stateCommitted = false;
		try {
			const recoveredRoutes =
				previous === undefined ? await this.#deps.discoverRoutes() : [];
			const staleRecoveredRoutes = recoveredRoutePlans(
				recoveredRoutes,
				next.routes,
			);
			for (const route of next.routes) {
				provisioned.push(await this.#deps.ensureRoute(route));
			}

			const removedRoutes = removedRoutePlans(
				previous?.routes ?? [],
				next.routes,
			);
			if (removedRoutes.length > 0 && previous !== undefined) {
				const transition = transitionState(previous, next, removedRoutes);
				await this.#deps.applyRuleset(buildShareRuleset(transition), "reload");
				for (const route of removedRoutes) {
					await this.#deps.flushConntrack(route.mark);
					await this.#deps.removeRoute(route);
					removedSupport.push(route);
					this.#deps.publishFlowsReset({
						iface: route.ifname,
						linkId: route.identity,
					});
				}
			}

			if (!isActive) {
				await this.#deps.deactivateSharing();
				stateCommitted = true;
				await this.#retireRecoveredRoutes(staleRecoveredRoutes);
				if (wasActive) await this.#deps.setIpForwarding(false);
				return;
			}

			const mode = wasActive ? "reload" : "activate";
			await this.#deps.applyRuleset(buildShareRuleset(next), mode);
			activatedService = mode === "activate";
			stateCommitted = true;
			await this.#retireRecoveredRoutes(staleRecoveredRoutes);
			if (!wasActive) await this.#deps.setIpForwarding(true);
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			if (activatedService) {
				try {
					await this.#deps.deactivateSharing();
				} catch (deactivateError) {
					rollbackErrors.push(deactivateError);
				}
			}
			if (!stateCommitted) {
				for (const route of removedSupport.reverse()) {
					try {
						await this.#deps.ensureRoute(route);
					} catch (restoreError) {
						rollbackErrors.push(restoreError);
					}
				}
			}
			for (const item of provisioned.reverse()) {
				if (!item.changed) continue;
				try {
					await this.#deps.rollbackRoute(item);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					`${error instanceof Error ? error.message : String(error)}; route rollback failed`,
				);
			}
			throw error;
		}
	}

	async #retireRecoveredRoutes(
		routes: readonly UplinkRoutePlan[],
	): Promise<void> {
		for (const route of routes) {
			await this.#deps.flushConntrack(route.mark);
			await this.#deps.removeRoute(route);
		}
	}
}

function removedRoutePlans(
	previous: readonly UplinkRoutePlan[],
	next: readonly UplinkRoutePlan[],
): UplinkRoutePlan[] {
	const retained = new Set(next.map(routeKey));
	return previous.filter((route) => !retained.has(routeKey(route)));
}

function routeKey(route: UplinkRoutePlan): string {
	return `${route.identity}\u0000${route.ifname}\u0000${route.table}\u0000${route.mark}`;
}

function recoveredRoutePlans(
	recovered: readonly UplinkRoutePlan[],
	desired: readonly UplinkRoutePlan[],
): UplinkRoutePlan[] {
	const retained = new Set(desired.map(recoveredRouteKey));
	return recovered.filter((route) => !retained.has(recoveredRouteKey(route)));
}

function recoveredRouteKey(route: UplinkRoutePlan): string {
	return `${route.mark}\u0000${route.table}`;
}

function transitionState(
	previous: PreparedSteeringState,
	next: PreparedSteeringState,
	removed: readonly UplinkRoutePlan[],
): ShareRulesetState {
	const removedKeys = new Set(removed.map(routeKey));
	const retainedSupport: SteeringUplink[] = [];
	for (const uplink of previous.uplinks) {
		const route = previous.routes.find(
			(candidate) =>
				candidate.identity === uplink.identity &&
				candidate.ifname === uplink.ifname,
		);
		if (route === undefined || !removedKeys.has(routeKey(route))) continue;
		retainedSupport.push({ ...uplink, selectable: false, weight: 0 });
	}
	return {
		clientZones: next.clientZones,
		uplinks: [...next.uplinks, ...retainedSupport],
	};
}
