import type { run } from "../../helpers/run.ts";
import type { ProbeCandidate } from "./connectivity-candidates.ts";
import type { ConnectivityProbes } from "./connectivity-election.ts";
import {
	parseRouteInventory,
	readOwnedInventory,
} from "./default-route-inventory.ts";
import { type DefaultRoute, GatewayRouteError } from "./default-route-model.ts";

const HEALTHY_SWEEPS = 3;
const RECOVERY_DWELL_MS = 10_000;
const OBSERVATION_GAP_MS = 30_000;

type NaturalDefaults = {
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

async function readNaturalDefaults(
	runner: typeof run,
): Promise<NaturalDefaults | undefined> {
	const inventory = await readOwnedInventory(runner);
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

export class NaturalUplinkRecovery {
	#streak:
		| {
				readonly key: string;
				readonly first: number;
				readonly last: number;
				readonly count: number;
		  }
		| undefined;
	#pending = false;

	constructor(private readonly runner: typeof run) {}

	get pending(): boolean {
		return this.#pending;
	}

	async observeOwnership(): Promise<void> {
		const inventory = await readOwnedInventory(this.runner);
		if (inventory.failures.length > 0)
			throw new GatewayRouteError(
				"",
				"invalid-route",
				new AggregateError(inventory.failures),
			);
		this.#pending = inventory.owned.length > 0;
	}

	async ready(
		candidates: readonly ProbeCandidate[],
		probes: ConnectivityProbes,
		now: () => number,
	): Promise<boolean> {
		this.#pending = false;
		try {
			const natural = await readNaturalDefaults(this.runner);
			if (!natural) {
				this.#streak = undefined;
				return false;
			}
			this.#pending = true;
			const names = new Set(candidates.map((candidate) => candidate.name));
			if (natural.ifnames.some((name) => !names.has(name))) {
				this.#streak = undefined;
				return false;
			}
			const results = await Promise.all(
				natural.ifnames.map((name) => probes.probeRepository(name)),
			);
			if (
				results.some(
					(result) =>
						(natural.family === 4 ? result.ipv4 : result.ipv6) !== "ok",
				)
			) {
				this.#streak = undefined;
				return false;
			}
			const at = now();
			const previous = this.#streak;
			const continuous =
				previous?.key === natural.key &&
				at >= previous.last &&
				at - previous.last <= OBSERVATION_GAP_MS;
			this.#streak = {
				key: natural.key,
				first: continuous ? previous.first : at,
				last: at,
				count: continuous ? previous.count + 1 : 1,
			};
			if (this.#streak.count < HEALTHY_SWEEPS) return false;
			const fresh = await readNaturalDefaults(this.runner);
			const finalAt = now();
			if (
				fresh?.key !== natural.key ||
				finalAt < at ||
				finalAt - at > OBSERVATION_GAP_MS
			) {
				this.#streak = undefined;
				return false;
			}
			return finalAt - this.#streak.first >= RECOVERY_DWELL_MS;
		} catch (error) {
			this.#streak = undefined;
			throw error;
		}
	}
}

const recoveries = new WeakMap<typeof run, NaturalUplinkRecovery>();
export function naturalUplinkRecovery(
	runner: typeof run,
): NaturalUplinkRecovery {
	let recovery = recoveries.get(runner);
	if (!recovery) {
		recovery = new NaturalUplinkRecovery(runner);
		recoveries.set(runner, recovery);
	}
	return recovery;
}
