import { ORPCError } from "@orpc/server";
import {
	type OsAttemptIntentStore,
	osAttemptIntentStore,
} from "./os-attempt-intent-store.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { readOsStageJob } from "./os-stage-job-files.ts";
import { UPDATE_STARTUP_PENDING } from "./startup-readiness.ts";

export function publishingIntentPending(
	store = osAttemptIntentStore(),
): boolean {
	try {
		return store.read()?.phase === "publishing";
	} catch (error) {
		if (error instanceof OsStageError) return true;
		throw error;
	}
}

export class OsAttemptIntentRecoveryFlight {
	#flight: Promise<boolean> | undefined;

	run(operation: () => Promise<boolean>): Promise<boolean> {
		if (this.#flight) return this.#flight;
		const flight = operation().finally(() => {
			if (this.#flight === flight) this.#flight = undefined;
		});
		this.#flight = flight;
		return flight;
	}

	resetForTest(): void {
		this.#flight = undefined;
	}
}

export async function awaitPublishingIntentForStream(port: {
	readonly store?: OsAttemptIntentStore;
	readonly recover: () => Promise<boolean>;
	readonly readJob: typeof readOsStageJob;
}): Promise<void> {
	const store = port.store ?? osAttemptIntentStore();
	if (!publishingIntentPending(store)) return;
	try {
		await port.recover();
	} catch (error) {
		// File parsers and guardian subprocesses also reject with non-stage errors.
		if (!(error instanceof Error)) throw error;
	}
	if (!publishingIntentPending(store)) return;
	try {
		const intent = store.read();
		const job = await port.readJob();
		if (intent && job?.launched && job.attemptId === intent.attemptId) return;
	} catch (error) {
		// Unreadable authority proves neither absence nor a cancellable producer.
		if (!(error instanceof Error)) throw error;
	}
	throw new ORPCError(UPDATE_STARTUP_PENDING, {
		message: "Update recovery is still initializing; retry shortly",
		data: { retryable: true },
	});
}
