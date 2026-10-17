import type { run } from "../../helpers/run.ts";
import type { ProbeCandidate } from "./connectivity-candidates.ts";
import type { ConnectivityProbes } from "./connectivity-election.ts";
import type { DefaultRouteReleaseCondition } from "./default-route.ts";
import { readOwnedInventory } from "./default-route-inventory.ts";
import { GatewayRouteError } from "./default-route-model.ts";
import {
	type NaturalDefaults,
	naturalDefaults,
} from "./natural-uplink-identity.ts";
import { observeRepository, observeUplinkPool } from "./uplink-observation.ts";

const HEALTHY_SWEEPS = 3;
const RECOVERY_DWELL_MS = 10_000;
const OBSERVATION_GAP_MS = 30_000;

async function readNaturalDefaults(
	runner: typeof run,
): Promise<NaturalDefaults | undefined> {
	return naturalDefaults(await readOwnedInventory(runner));
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
	#releaseCondition: DefaultRouteReleaseCondition | undefined;

	constructor(private readonly runner: typeof run) {}

	get pending(): boolean {
		return this.#pending;
	}

	get releaseCondition(): DefaultRouteReleaseCondition | undefined {
		return this.#releaseCondition;
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
		this.#releaseCondition = undefined;
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
			const results = await observeUplinkPool(natural.ifnames, (name) =>
				observeRepository(name, probes),
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
			if (finalAt - this.#streak.first < RECOVERY_DWELL_MS) return false;
			this.#releaseCondition = (inventory) => {
				this.#streak = undefined;
				this.#pending = true;
				const current = naturalDefaults(inventory);
				const releaseAt = now();
				if (
					current?.key !== natural.key ||
					releaseAt < finalAt ||
					releaseAt - finalAt > OBSERVATION_GAP_MS
				)
					return false;
				this.#pending = false;
				return true;
			};
			return true;
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
