import { updateOrchestratorPersistedStateSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { fromPersisted, toPersisted } from "./persistence.ts";
import type { RecoveryProbes } from "./recovery-probes.ts";
import {
	AGENT_FILE,
	PLAN_FILE,
	type RecoveryIdentity,
	type RecoveryReceipt,
	type RecoveryStore,
	recoveryIdentitySchema,
	sha256,
} from "./recovery-store.ts";
import { reduceOrchestrator } from "./reducer.ts";

const planSchema = z
	.array(
		z
			.object({
				name: z.string().regex(/^[a-z0-9][a-z0-9+.-]*$/),
				version: z.string().regex(/^[0-9][a-zA-Z0-9.+:~_-]*$/),
			})
			.strict(),
	)
	.min(1);

export class RecoveryRefusal extends Error {
	override readonly name = "RecoveryRefusal";
	constructor(readonly reason: string) {
		super(reason);
	}
}

export interface RecoveryDeps {
	readonly store: RecoveryStore;
	readonly probes: RecoveryProbes;
	readonly withLock: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly now: () => number;
}

export type RecoveryOutcome = {
	readonly kind: "cleared" | "already-cleared";
	readonly receiptId: string;
};

function requireEvidence(value: boolean, reason: string): void {
	if (!value) throw new RecoveryRefusal(reason);
}

async function admission(
	identity: RecoveryIdentity,
	deps: RecoveryDeps,
	plan: z.infer<typeof planSchema>,
): Promise<void> {
	const { probes } = deps;
	requireEvidence(probes.root(), "root_required");
	requireEvidence(
		await probes.backendStopped(),
		"backend_must_be_inactive_and_runtime_masked",
	);
	requireEvidence(await probes.unitAbsent(), "commit_unit_must_be_absent");
	requireEvidence(await probes.operationsIdle(), "concurrent_operation");
	requireEvidence(await probes.dpkgClean(), "dpkg_dirty");
	const observed = await probes.identity();
	requireEvidence(
		observed.bootId === identity.bootId &&
			observed.slot === identity.slot &&
			observed.compatible === identity.compatible &&
			observed.osVersion === identity.osVersion,
		"boot_slot_or_os_changed",
	);
	for (const candidate of plan) {
		requireEvidence(
			await probes.candidateUnapplied(candidate.name, candidate.version),
			"candidate_installed_on_current_slot",
		);
	}
}

async function recoverLocked(
	identity: RecoveryIdentity,
	deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
	const { store } = deps;
	const receiptId = sha256(
		Buffer.from(`${identity.agentSha256}:${identity.planSha256}`),
	);
	const receipt = await store.readReceipt(receiptId);
	const agent = await store.read(AGENT_FILE);
	if (!agent) throw new RecoveryRefusal("agent_missing");
	const planOnDisk = await store.read(PLAN_FILE);
	if (receipt) {
		requireEvidence(
			receipt.id === receiptId &&
				JSON.stringify(receipt.identity) === JSON.stringify(identity) &&
				sha256(Buffer.from(receipt.agentBase64, "base64")) ===
					identity.agentSha256 &&
				sha256(Buffer.from(receipt.planBase64, "base64")) ===
					identity.planSha256,
			"receipt_mismatch",
		);
	}
	const planBytes =
		planOnDisk ?? (receipt ? Buffer.from(receipt.planBase64, "base64") : null);
	if (!planBytes) throw new RecoveryRefusal("pending_plan_missing");
	requireEvidence(
		sha256(planBytes) === identity.planSha256,
		"pending_plan_hash_mismatch",
	);
	const plan = planSchema.parse(JSON.parse(planBytes.toString("utf8")));
	const state = updateOrchestratorPersistedStateSchema.parse(
		JSON.parse(agent.toString("utf8")),
	);
	if (receipt && state.phase === "idle" && !planOnDisk) {
		requireEvidence(
			sha256(agent) === receipt.clearedAgentSha256,
			"cleared_state_changed",
		);
		await admission(identity, deps, plan);
		return { kind: "already-cleared", receiptId };
	}
	requireEvidence(
		state.phase === "failed" &&
			state.failureReason === "commit_unit_absent_on_resume",
		"wrong_failure",
	);
	requireEvidence(
		sha256(agent) === identity.agentSha256,
		"agent_hash_mismatch",
	);
	const next = reduceOrchestrator(fromPersisted(state), {
		type: "HISTORICAL_COMMIT_ADJUDICATED",
		now: receipt?.decidedAt ?? deps.now(),
		decision: "historical_outcome_unresolved_current_slot_unapplied",
		receiptId,
	});
	requireEvidence(next.phase === "idle", "transition_refused");
	const clearedBytes = Buffer.from(JSON.stringify(toPersisted(next)));
	if (receipt)
		requireEvidence(
			sha256(clearedBytes) === receipt.clearedAgentSha256,
			"receipt_mismatch",
		);
	await admission(identity, deps, plan);
	if (!receipt) {
		const record: RecoveryReceipt = {
			schema: 1,
			id: receiptId,
			decision: "historical_outcome_unresolved_current_slot_unapplied",
			identity,
			agentBase64: agent.toString("base64"),
			planBase64: planBytes.toString("base64"),
			clearedAgentSha256: sha256(clearedBytes),
			decidedAt: next.enteredAt,
		};
		await store.writeReceipt(record);
	}
	// Each checkpoint repeats the live exclusion probes. The receipt contains both
	// original byte streams, so either a receipt-first or an archive-first crash
	// can resume without reconstructing the old slot's outcome.
	await admission(identity, deps, plan);
	requireEvidence(
		sha256((await store.read(AGENT_FILE)) ?? Buffer.alloc(0)) ===
			identity.agentSha256,
		"agent_hash_mismatch",
	);
	if (planOnDisk)
		requireEvidence(
			sha256((await store.read(PLAN_FILE)) ?? Buffer.alloc(0)) ===
				identity.planSha256,
			"pending_plan_hash_mismatch",
		);
	await store.archivePlan();
	await admission(identity, deps, plan);
	requireEvidence(
		sha256((await store.read(AGENT_FILE)) ?? Buffer.alloc(0)) ===
			identity.agentSha256,
		"agent_hash_mismatch",
	);
	await store.writeState(clearedBytes);
	return { kind: "cleared", receiptId };
}

export async function recoverCrossSlot(
	identityInput: RecoveryIdentity,
	deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
	const identity = recoveryIdentitySchema.parse(identityInput);
	requireEvidence(deps.probes.root(), "root_required");
	return deps.withLock(() => recoverLocked(identity, deps));
}
