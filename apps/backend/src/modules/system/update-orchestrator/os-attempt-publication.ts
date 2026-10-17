import { isDeepStrictEqual } from "node:util";
import {
	type OsAttemptIntent,
	osAttemptIntentSchema,
} from "./os-attempt-intent.ts";
import {
	type OsAttemptIntentStore,
	osAttemptIntentStore,
} from "./os-attempt-intent-store.ts";
import type { OsChannelManifest } from "./os-manifest.ts";
import type { OsSettlementPersistence } from "./os-settlement-persistence.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { toPersisted } from "./persistence.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorEvent, OrchestratorState } from "./types.ts";

export class OsAttemptPublicationError extends Error {
	override readonly name = "OsAttemptPublicationError";
	constructor(
		cause: unknown,
		readonly rollbackError?: unknown,
	) {
		super("OS attempt publication failed before staging effects", { cause });
	}
}

type AttemptPublicationPort = {
	readonly manifest: OsChannelManifest;
	readonly lease: OsStageControlLease;
	readonly intentStore?: OsAttemptIntentStore;
	readonly snapshot: () => OrchestratorState;
	readonly dispatch: (event: OrchestratorEvent) => OrchestratorState;
	readonly adopt: (state: OrchestratorState) => void;
	readonly persist: (state: OrchestratorState) => void;
};

type AttemptStarted = Extract<
	OrchestratorEvent,
	{ type: "OS_STAGING_STARTED" }
>;
type IdentifiedAttemptStarted = AttemptStarted & {
	readonly attempt: NonNullable<AttemptStarted["attempt"]>;
};

/** Called synchronously under CONTROL, before stageOs can create a producer. */
export function publishOsAttempt(
	port: AttemptPublicationPort,
	event: IdentifiedAttemptStarted,
	durability: OsSettlementPersistence,
): void {
	const before = port.snapshot();
	const store = port.intentStore ?? osAttemptIntentStore();
	let intent: OsAttemptIntent | undefined;
	let published = false;
	try {
		if (!port.lease.held()) throw new OsAttemptPublicationError(undefined);
		intent = osAttemptIntentSchema.parse({
			schema: 1,
			attemptId: event.attempt.attemptId,
			manifest: port.manifest,
			phase: "publishing",
			before: toPersisted(before),
			staged: toPersisted(reduceOrchestrator(before, event)),
		});
		store.write(intent, null);
		published = true;
		port.dispatch(event);
		store.write({ ...intent, phase: "launching" }, intent);
	} catch (error) {
		if (!published) throw new OsAttemptPublicationError(error);
		const attempted = port.snapshot();
		port.adopt(before);
		try {
			durability.save(attempted, before, () => {
				port.persist(before);
				const current = store.read();
				if (
					intent &&
					current &&
					isDeepStrictEqual({ ...current, phase: "publishing" }, intent)
				)
					durability.intentCleanup.retire(store, current);
			});
		} catch (rollbackError) {
			throw new OsAttemptPublicationError(error, rollbackError);
		}
		throw new OsAttemptPublicationError(error);
	}
}
