import { logger } from "../../../helpers/logger.ts";
import {
	defaultStartupRetryClock,
	isTransientUpdateStartupFailure,
	retryUpdateStartup,
	type StartupRetryClock,
} from "./startup-retry.ts";

export const UPDATE_STARTUP_BACKGROUND_RETRY_MS = 30_000;

/** Retains the burst verdict while one timer owns eventual startup adjudication. */
export class UpdateStartupCadence {
	#initial: Promise<void> | undefined;
	#adjudication = Promise.withResolvers<boolean>();
	#timer: { readonly cancel: () => void } | undefined;
	#generation = 0;

	start(
		work: () => Promise<void>,
		clock: StartupRetryClock = defaultStartupRetryClock,
	): Promise<void> {
		if (this.#initial) return this.#initial;
		const generation = this.#generation;
		this.#initial = retryUpdateStartup(work, clock).then(
			() => {
				if (generation === this.#generation) this.#adjudication.resolve(true);
			},
			(error: unknown) => {
				if (generation === this.#generation) {
					if (isTransientUpdateStartupFailure(error)) {
						logger.warn(
							"update-orchestrator: startup retry burst exhausted; background cadence continues with mutations closed",
							{ error, delayMs: UPDATE_STARTUP_BACKGROUND_RETRY_MS },
						);
						this.#schedule(work, clock);
					} else this.#adjudication.resolve(false);
				}
				throw error;
			},
		);
		return this.#initial;
	}

	waitForAdjudication(): Promise<boolean> {
		return this.#adjudication.promise;
	}

	#schedule(work: () => Promise<void>, clock: StartupRetryClock): void {
		const generation = this.#generation;
		const timer = clock.scheduleBackground?.(async () => {
			if (generation !== this.#generation) return;
			this.#timer = undefined;
			try {
				await work();
				if (generation === this.#generation) this.#adjudication.resolve(true);
			} catch (error) {
				if (generation !== this.#generation) return;
				if (isTransientUpdateStartupFailure(error)) {
					logger.warn(
						"update-orchestrator: background startup retry deferred",
						{
							error,
							delayMs: UPDATE_STARTUP_BACKGROUND_RETRY_MS,
						},
					);
					this.#schedule(work, clock);
				} else {
					logger.error("update-orchestrator: background startup refused", {
						error,
					});
					this.#adjudication.resolve(false);
				}
			}
		}, UPDATE_STARTUP_BACKGROUND_RETRY_MS);
		timer?.unref();
		this.#timer = timer;
	}

	resetForTest(): void {
		this.#generation++;
		this.#timer?.cancel();
		this.#timer = undefined;
		this.#initial = undefined;
		this.#adjudication.resolve(false);
		this.#adjudication = Promise.withResolvers<boolean>();
	}
}
