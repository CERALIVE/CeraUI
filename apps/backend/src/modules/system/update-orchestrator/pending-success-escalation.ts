import { logger } from "../../../helpers/logger.ts";
import { markBootDegraded } from "../readiness.ts";
import type { OrchestratorState } from "./types.ts";

const DRIFT_ATTEMPTS = 5;
const LOG_INTERVAL_MS = 60_000;
const PACKAGE_COMPLETION_PHASES: readonly OrchestratorState["phase"][] = [
	"committing",
	"downloading",
	"restarting-services",
	"settled",
];

export class PendingSuccessEscalation {
	#drift = 0;
	#escalated = false;
	#logged = new Map<string, number>();
	#justEscalated = false;

	matched(): void {
		this.#drift = 0;
	}

	mismatch(disk: OrchestratorState | null): void {
		this.#drift++;
		if (this.#escalated) return;
		const phaseChanged =
			disk !== null && !PACKAGE_COMPLETION_PHASES.includes(disk.phase);
		if (!phaseChanged && this.#drift < DRIFT_ATTEMPTS) return;
		this.#escalated = true;
		this.#justEscalated = true;
		markBootDegraded("update-orchestrator-maintenance");
		logger.error(
			"Package success replay requires local maintenance; fence remains closed",
			{
				reason: phaseChanged
					? "package_success_phase_changed"
					: "package_success_baseline_drift",
				phase: disk?.phase ?? null,
				attempts: this.#drift,
				remedy:
					"Inspect agent.json and installed packages before restarting ceralive.service",
			},
		);
	}

	failure(error: unknown, now: number): void {
		const signature =
			error instanceof Error ? `${error.name}:${error.message}` : String(error);
		if (this.#drift === 0) markBootDegraded("update-orchestrator-maintenance");
		if (this.#justEscalated) {
			this.#justEscalated = false;
			this.#logged.set(signature, now);
			return;
		}
		const last = this.#logged.get(signature);
		if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
		this.#logged.set(signature, now);
		logger.error(
			"Package success persistence retry withheld scheduler effects",
			{ error },
		);
	}
}
