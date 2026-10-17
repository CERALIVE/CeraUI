import { OsAttemptIntentRecoveryFlight } from "./os-attempt-intent-admission.ts";
import { OsAttemptIntentCleanup } from "./os-attempt-intent-cleanup.ts";
import {
	OsSnapshotReplay,
	type OsSnapshotReplayPort,
} from "./os-snapshot-replay.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorEvent, OrchestratorState } from "./types.ts";

/** dispatch adopts memory before writing; a thrown write cannot grant admission. */
export class OsSettlementPersistence {
	readonly intentCleanup = new OsAttemptIntentCleanup();
	readonly intentRecovery = new OsAttemptIntentRecoveryFlight();
	#pending = false;
	#replay: OsSnapshotReplay | undefined;
	constructor(readonly publishingPending: () => boolean = () => false) {}

	get pending(): boolean {
		return (
			this.#pending || this.intentCleanup.pending || this.publishingPending()
		);
	}

	get snapshotPending(): boolean {
		return this.#pending;
	}

	get replayPending(): boolean {
		return this.#replay !== undefined;
	}

	settle(
		port: {
			readonly snapshot: () => OrchestratorState;
			readonly dispatch: (event: OrchestratorEvent) => OrchestratorState;
		},
		event: OrchestratorEvent,
	): OrchestratorState {
		const baseline = port.snapshot();
		const settled = reduceOrchestrator(baseline, event);
		this.#replay = new OsSnapshotReplay(baseline, settled);
		let result = baseline;
		this.persist(() => {
			result = port.dispatch(event);
		});
		this.#replay = undefined;
		return result;
	}

	async replay(port: OsSnapshotReplayPort): Promise<boolean> {
		const replay = this.#replay;
		if (!replay) return false;
		await replay.replay(port);
		this.#replay = undefined;
		this.#pending = false;
		return true;
	}

	save(
		baseline: OrchestratorState | null,
		settled: OrchestratorState,
		write: () => void,
	): void {
		this.#replay = new OsSnapshotReplay(baseline, settled);
		this.persist(write);
		this.#replay = undefined;
	}

	persist(write: () => void): void {
		this.#pending = true;
		write();
		this.#pending = false;
	}

	resetForTest(): void {
		this.intentCleanup.resetForTest();
		this.intentRecovery.resetForTest();
		this.#pending = false;
		this.#replay = undefined;
	}
}
