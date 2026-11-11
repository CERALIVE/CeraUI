import { logger } from "../../../helpers/logger.ts";
import type { PreparedSteeringState } from "./applier.ts";
import {
	type SteeringAvailability,
	SteeringUnavailableError,
	type SteeringUnavailableReason,
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
	retryCleanup?(): Promise<void>;
	now?(): number;
}

export class UplinkSteeringCoordinator {
	readonly #deps: UplinkSteeringCoordinatorDeps;
	#applied: PreparedSteeringState | undefined;
	#dirty = false;
	#running: Promise<void> | undefined;
	#lastFailure:
		| {
				stateKey: string;
				reason: SteeringUnavailableReason;
				attempts: number;
				nextAttemptAt: number;
		  }
		| undefined;

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
			let desiredKey: string | undefined;
			try {
				const desired = await this.#deps.readDesiredState();
				desiredKey = stateKey(desired);
				if (this.#lastFailure?.stateKey !== desiredKey) {
					this.#lastFailure = undefined;
				}
				if (
					this.#lastFailure === undefined ||
					(this.#deps.now ?? Date.now)() >= this.#lastFailure.nextAttemptAt
				) {
					if (stateKey(this.#applied) !== desiredKey) {
						await this.#deps.apply(this.#applied, desired);
					}
					this.#applied = desired;
					this.#lastFailure = undefined;
					this.#deps.publishAvailability({ available: true });
					retryIndex = 0;
				}
				try {
					await this.#deps.retryCleanup?.();
				} catch (error) {
					logger.warn("uplink steering pending cleanup failed", { err: error });
				}
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
				const retryDelay =
					this.#lastFailure === undefined || desiredKey === undefined
						? UPLINK_STEERING_RETRY_DELAYS_MS[retryIndex]
						: undefined;
				if (retryDelay !== undefined) {
					retryIndex++;
					await (this.#deps.waitBeforeRetry ?? defaultWait)(retryDelay);
					this.#dirty = true;
				} else if (desiredKey !== undefined) {
					const attempts = (this.#lastFailure?.attempts ?? 0) + 1;
					this.#lastFailure = {
						stateKey: desiredKey,
						reason,
						attempts,
						nextAttemptAt:
							(this.#deps.now ?? Date.now)() +
							Math.min(5_000 * 2 ** (attempts - 1), 60_000),
					};
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
