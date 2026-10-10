import { OsStageError } from "./os-stage-error.ts";
import { reportStageProofDecision } from "./os-stage-proof-wait.ts";

export const RAUC_RECOVERY_POLL_MS = 1_000;
export const RAUC_RECOVERY_DEADLINE_MS = 360_000;

export type RaucStageSnapshot = {
	readonly instance: string;
	readonly active: boolean;
	readonly operation: string | null;
	readonly processes: readonly string[];
	readonly resources: readonly string[];
	readonly bootId: string;
	readonly bootPrimary: string | null;
	readonly bootedSlot: string;
	readonly bootedDevice: string;
	readonly bootedHealthy: boolean;
	readonly targetSlot: string;
	readonly targetDevice: string;
	readonly targetInactive: boolean;
	readonly activationArmed: boolean;
};

export type RaucAttemptOwnership = {
	readonly baseline: RaucStageSnapshot;
	readonly processes: ReadonlySet<string>;
	readonly resources: ReadonlySet<string>;
};

export function raucQuiescenceRefusal(input: {
	readonly ownership: RaucAttemptOwnership;
	readonly current: RaucStageSnapshot | null;
	readonly cliSettled: boolean;
	readonly lockHeld: boolean;
	readonly requireNewInstance: boolean;
}): string | null {
	const { ownership, current, cliSettled, lockHeld, requireNewInstance } =
		input;
	if (!cliSettled) return "cli-unsettled";
	if (!lockHeld) return "lock-owner-unproven";
	if (!current) return "observation-unknown";
	if (!current.active || current.operation !== "idle")
		return "daemon-not-ready";
	if (
		!current.instance ||
		(requireNewInstance && current.instance === ownership.baseline.instance)
	)
		return "old-daemon-instance";
	const surviving = current.processes.filter((id) =>
		ownership.processes.has(id),
	);
	if (surviving.some((id) => id !== current.instance))
		return "old-installer-survives";
	if (current.processes.some((id) => id !== current.instance))
		return "installer-ownership-unproven";
	if (current.resources.some((id) => ownership.resources.has(id)))
		return "owned-resource-survives";
	// A new RAUC resource with missed ownership is uncertainty, not permission to retry.
	if (current.resources.length) return "resource-ownership-unproven";
	const before = ownership.baseline;
	if (
		!current.bootPrimary ||
		!before.bootPrimary ||
		current.bootPrimary !== before.bootPrimary ||
		current.bootPrimary !== current.bootedSlot ||
		current.bootPrimary === current.targetSlot
	)
		return "activation-identity-unproven-or-changed";
	if (
		current.bootId !== before.bootId ||
		current.bootedSlot !== before.bootedSlot ||
		current.bootedDevice !== before.bootedDevice ||
		!current.bootedHealthy
	)
		return "booted-slot-changed-or-unhealthy";
	if (
		current.targetSlot !== before.targetSlot ||
		current.targetDevice !== before.targetDevice ||
		!current.targetInactive
	)
		return "target-not-inactive";
	if (current.activationArmed) return "activation-armed";
	return null;
}

export type RaucRecoveryDeps = {
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly observe: () => Promise<RaucStageSnapshot | null>;
	readonly cliSettled: () => boolean;
	readonly lockHeld: () => Promise<boolean>;
	readonly deadline?: number;
};

export async function recoverRaucStage(
	ownership: RaucAttemptOwnership,
	deps: RaucRecoveryDeps,
	requireNewInstance: boolean,
): Promise<RaucStageSnapshot> {
	const deadline = deps.deadline ?? deps.now() + RAUC_RECOVERY_DEADLINE_MS;
	let refusal = "observation-unknown";
	const wait = {
		deadline,
		now: deps.now,
		previousInstance: ownership.baseline.instance,
	};
	let previousReason: string | undefined;
	let lastCurrent: RaucStageSnapshot | null = null;
	do {
		const current = await deps.observe();
		lastCurrent = current;
		const lockHeld = await deps.lockHeld();
		const structural =
			current &&
			raucQuiescenceRefusal({
				ownership,
				current: {
					...current,
					active: true,
					operation: "idle",
					processes: [current.instance],
					resources: [],
				},
				cliSettled: true,
				lockHeld,
				requireNewInstance: false,
			});
		const reason = raucQuiescenceRefusal({
			ownership,
			current,
			cliSettled: deps.cliSettled(),
			lockHeld,
			requireNewInstance,
		});
		if (reason === null && current && deps.now() < deadline) {
			reportStageProofDecision({
				snapshot: current,
				wait,
				reason: "recovery-proven",
				disposition: "proven",
			});
			return current;
		}
		if (!lockHeld || structural) {
			refusal = structural ?? "lock-owner-unproven";
			break;
		}
		if (reason === null) {
			refusal = "deadline-expired";
			break;
		}
		refusal = reason ?? "observation-unknown";
		if (refusal !== previousReason) {
			previousReason = refusal;
			reportStageProofDecision({
				snapshot: current,
				wait,
				reason: refusal,
				disposition: deps.now() >= deadline ? "final" : "defer",
			});
		}
		if (deps.now() >= deadline) break;
		await deps.sleep(Math.min(RAUC_RECOVERY_POLL_MS, deadline - deps.now()));
	} while (deps.now() <= deadline);
	reportStageProofDecision({
		snapshot: lastCurrent,
		wait,
		reason: refusal,
		disposition: "final",
	});
	throw new OsStageError("rauc_recovery_unproven", {
		diagnostics: { refusal, oldInstance: ownership.baseline.instance },
	});
}
