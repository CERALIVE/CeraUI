import { isDeepStrictEqual } from "node:util";
import { clearOsStageNotices } from "./notifications.ts";
import { replaceOsStageRecoveryNotice } from "./os-recovery-notice.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { osStageNoticeId } from "./os-stage-retry.ts";
import { type loadOrchestratorState, toPersisted } from "./persistence.ts";
import type { OrchestratorState } from "./types.ts";

export type OsSnapshotReplayPort = {
	readonly snapshot: () => OrchestratorState;
	readonly acquireControl: () => Promise<OsStageControlLease>;
	readonly readPersisted: typeof loadOrchestratorState;
	readonly persist: (state: OrchestratorState) => void;
	readonly publish: () => void;
};

export class OsSnapshotReplay {
	#flight: Promise<void> | undefined;
	constructor(
		readonly baseline: OrchestratorState | null,
		readonly settled: OrchestratorState,
	) {}

	replay(port: OsSnapshotReplayPort): Promise<void> {
		if (this.#flight) return this.#flight;
		const flight = this.#write(port).finally(() => {
			if (this.#flight === flight) this.#flight = undefined;
		});
		this.#flight = flight;
		return flight;
	}

	async #write(port: OsSnapshotReplayPort): Promise<void> {
		await using lease = await port.acquireControl();
		const persisted = await port.readPersisted();
		if (
			!lease.held() ||
			!isDeepStrictEqual(
				toPersisted(port.snapshot()),
				toPersisted(this.settled),
			) ||
			![this.baseline, this.settled].some((snapshot) =>
				isDeepStrictEqual(
					snapshot && toPersisted(snapshot),
					persisted && toPersisted(persisted),
				),
			)
		)
			throw new OsStageError("rauc_recovery_unproven");
		port.persist(this.settled);
		port.publish();
		if (this.baseline?.osStageRecovery && !this.settled.osStageRecovery)
			clearOsStageNotices(
				osStageNoticeId(this.baseline.osStageRecovery.candidateKey),
			);
		replaceOsStageRecoveryNotice(this.settled);
	}
}
