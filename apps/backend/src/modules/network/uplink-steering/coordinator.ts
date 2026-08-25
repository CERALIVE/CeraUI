import type { PreparedSteeringState } from "./applier.ts";
import {
	type SteeringAvailability,
	SteeringUnavailableError,
} from "./contracts.ts";

export const UPLINK_STEERING_RETRY_DELAYS_MS = [100, 500] as const;

export interface UplinkSteeringCoordinatorDeps {
	readDesiredState(): Promise<PreparedSteeringState>;
	apply(
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	): Promise<void>;
	publishAvailability(status: SteeringAvailability): void;
	waitBeforeRetry?(delayMs: number): Promise<void>;
}

export class UplinkSteeringCoordinator {
	readonly #deps: UplinkSteeringCoordinatorDeps;
	#applied: PreparedSteeringState | undefined;
	#dirty = false;
	#running: Promise<void> | undefined;

	constructor(deps: UplinkSteeringCoordinatorDeps) {
		this.#deps = deps;
	}

	requestReconcile(): Promise<void> {
		this.#dirty = true;
		if (this.#running !== undefined) return this.#running;
		this.#running = this.#drain().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	appliedState(): PreparedSteeringState | undefined {
		return this.#applied;
	}

	async #drain(): Promise<void> {
		let retryIndex = 0;
		while (this.#dirty) {
			this.#dirty = false;
			try {
				const desired = await this.#deps.readDesiredState();
				if (stateKey(this.#applied) !== stateKey(desired)) {
					await this.#deps.apply(this.#applied, desired);
				}
				this.#applied = desired;
				this.#deps.publishAvailability({ available: true });
				retryIndex = 0;
			} catch (error) {
				const reason =
					error instanceof SteeringUnavailableError
						? error.reason
						: "ruleset_reload_failed";
				this.#deps.publishAvailability({
					available: false,
					reason,
					detail: error instanceof Error ? error.message : String(error),
				});
				const retryDelay = UPLINK_STEERING_RETRY_DELAYS_MS[retryIndex];
				if (retryDelay !== undefined) {
					retryIndex++;
					await (this.#deps.waitBeforeRetry ?? defaultWait)(retryDelay);
					this.#dirty = true;
				}
			}
		}
	}
}

function stateKey(
	state: PreparedSteeringState | undefined,
): string | undefined {
	return state === undefined ? undefined : JSON.stringify(state);
}

async function defaultWait(delayMs: number): Promise<void> {
	await Bun.sleep(delayMs);
}
