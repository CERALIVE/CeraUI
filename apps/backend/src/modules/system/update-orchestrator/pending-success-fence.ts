import type { CommitExitHook } from "../software-update-restart.ts";
import type { OsRecoverySettlementPort } from "./os-authoritative-settlement.ts";
import { PendingSuccessEscalation } from "./pending-success-escalation.ts";
import {
	samePackageSuccessState as same,
	samePackageCompletion,
	packageSuccessState as successState,
} from "./pending-success-state.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorState } from "./types.ts";

export class PendingPackageSuccessError extends Error {
	override readonly name = "PendingPackageSuccessError";
}

type PendingSuccess = {
	readonly baseline: OrchestratorState;
	readonly permission: ReturnType<typeof Promise.withResolvers<boolean>>;
	readonly escalation: PendingSuccessEscalation;
	intent: OrchestratorState | null;
};

type PackageSuccessPort = OsRecoverySettlementPort & {
	readonly onPending?: () => void;
	readonly onDurable?: () => void;
};

/** Retains observed completion independently of the mutable legacy wire result. */
class PendingSuccessFence {
	#port: PackageSuccessPort | undefined;
	#accept: ((state: OrchestratorState) => void) | undefined;
	#now: () => number = Date.now;
	#trackedBaseline: OrchestratorState | undefined;
	#success: PendingSuccess | undefined;
	#replay: Promise<void> | undefined;

	get pending(): boolean {
		return this.#success !== undefined;
	}

	configure(
		port: PackageSuccessPort,
		accept: (state: OrchestratorState) => void,
		now: () => number,
	): void {
		this.#port = port;
		this.#accept = accept;
		this.#now = now;
	}

	trackStartup(baseline: OrchestratorState | undefined): void {
		this.#trackedBaseline = baseline;
	}

	observe(): void {
		if (!this.#port || this.#success) return;
		const baseline = this.#trackedBaseline ?? this.#port.snapshot();
		this.#success = {
			baseline,
			intent: successState(baseline, this.#now()),
			permission: Promise.withResolvers<boolean>(),
			escalation: new PendingSuccessEscalation(),
		};
		this.#port.onPending?.();
	}

	retain(baseline: OrchestratorState, intent: OrchestratorState): void {
		const retained = this.#success?.baseline ?? baseline;
		if (
			!samePackageCompletion(retained, baseline) ||
			!samePackageCompletion(retained, intent)
		)
			throw new PendingPackageSuccessError(
				"package completion identity changed",
			);
		this.#success = {
			baseline: retained,
			intent,
			permission: this.#success?.permission ?? Promise.withResolvers<boolean>(),
			escalation: this.#success?.escalation ?? new PendingSuccessEscalation(),
		};
		this.#port?.onPending?.();
	}

	acknowledge(state: OrchestratorState): void {
		if (
			this.#success &&
			samePackageCompletion(this.#success.baseline, state) &&
			(state.phase === "restarting-services" || state.phase === "settled")
		) {
			this.#success?.permission.resolve(true);
			this.#success = undefined;
			this.#port?.onDurable?.();
		}
	}

	waitForDurability(): Promise<boolean> {
		return this.#success?.permission.promise ?? Promise.resolve(false);
	}

	invoke(hook: CommitExitHook): undefined | Promise<boolean> {
		this.observe();
		try {
			const permission = hook();
			if (permission !== undefined) return permission;
			const current = this.#port?.snapshot();
			if (current && this.pending) {
				if (
					current.phase !== "restarting-services" &&
					current.phase !== "settled"
				)
					throw new PendingPackageSuccessError(
						"successful package completion did not reach durable success",
					);
				return this.#confirm(current);
			}
			return undefined;
		} finally {
			const current = this.#port?.snapshot();
			if (
				current &&
				this.#success &&
				samePackageCompletion(this.#success.baseline, current)
			) {
				this.#success.intent = successState(current, current.enteredAt);
			}
		}
	}

	async #confirm(current: OrchestratorState): Promise<boolean> {
		const port = this.#port;
		const pending = this.#success;
		if (!port || !pending) return false;
		await using lease = await port.acquireControl();
		if (this.#success !== pending) return false;
		const disk = await port.readPersisted();
		if (this.#success !== pending) return false;
		if (
			!lease.held() ||
			port.pending() ||
			port.snapshot() !== current ||
			!samePackageCompletion(pending.baseline, current) ||
			!same(disk, current)
		)
			throw new PendingPackageSuccessError(
				"successful callback lacks authoritative durable acknowledgement",
			);
		// Readable rename equality cannot acknowledge the parent-directory fsync.
		port.persist(current);
		this.acknowledge(current);
		return true;
	}

	async retry(): Promise<void> {
		if (this.#replay) return this.#replay;
		const work = this.#persist();
		this.#replay = work;
		try {
			await work;
		} finally {
			if (this.#replay === work) this.#replay = undefined;
		}
	}

	async #persist(): Promise<void> {
		const pending = this.#success;
		const port = this.#port;
		if (!pending || !port || !pending.intent) return;
		try {
			await using lease = await port.acquireControl();
			if (this.#success !== pending) return;
			const before = port.snapshot();
			const disk = await port.readPersisted();
			if (this.#success !== pending) return;
			const intent = pending.intent;
			if (!intent) return;
			const intermediate = reduceOrchestrator(pending.baseline, {
				type: "COMMIT_PHASE_ENTERED",
				now: intent.enteredAt,
			});
			const matches =
				same(disk, pending.baseline) ||
				same(disk, intermediate) ||
				same(disk, intent);
			if (matches) pending.escalation.matched();
			else pending.escalation.mismatch(disk);
			if (
				!lease.held() ||
				port.pending() ||
				port.snapshot() !== before ||
				!samePackageCompletion(pending.baseline, before) ||
				!matches
			)
				throw new PendingPackageSuccessError(
					"authoritative package success baseline changed",
				);
			port.persist(intent);
			this.#accept?.(intent);
			this.acknowledge(intent);
		} catch (error) {
			if (this.#success !== pending) return;
			pending.escalation.failure(error, this.#now());
		}
	}

	assertEffectsAllowed(): void {
		if (this.pending)
			throw new PendingPackageSuccessError(
				"package success persistence pending",
			);
	}

	resetForTest(): void {
		this.#success?.permission.resolve(false);
		this.#success = undefined;
		this.#port = undefined;
		this.#accept = undefined;
		this.#trackedBaseline = undefined;
		this.#replay = undefined;
	}
}

export const pendingPackageSuccess = new PendingSuccessFence();
