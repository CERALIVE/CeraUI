import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPersisted } from "../modules/system/update-orchestrator/persistence.ts";
import {
	type RecoveryDeps,
	RecoveryRefusal,
} from "../modules/system/update-orchestrator/recovery.ts";
import type { RecoveryProbes } from "../modules/system/update-orchestrator/recovery-probes.ts";
import {
	fileRecoveryStore,
	type RecoveryIdentity,
	sha256,
} from "../modules/system/update-orchestrator/recovery-store.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

export const candidate = [
	{ name: "ceralive-apt-credentials", version: "1.0.1" },
];
export interface RecoveryFixture {
	readonly dir: string;
	readonly identity: RecoveryIdentity;
	readonly deps: RecoveryDeps;
	readonly flags: {
		root: boolean;
		stopped: boolean;
		unitAbsent: boolean;
		idle: boolean;
		clean: boolean;
		unapplied: boolean;
		lock: boolean;
	};
	close(): Promise<void>;
}

export async function createRecoveryFixture(): Promise<RecoveryFixture> {
	const dir = await mkdtemp(join(tmpdir(), "ceraui-cross-slot-"));
	const agent = Buffer.from(
		JSON.stringify(
			toPersisted({
				...initialOrchestratorState(1),
				phase: "failed",
				failureReason: "commit_unit_absent_on_resume",
				packageCheck: {
					...initialOrchestratorState(1).packageCheck,
					nextAttemptAt: 9,
				},
			}),
		),
	);
	const plan = Buffer.from(JSON.stringify(candidate));
	await writeFile(join(dir, "agent.json"), agent);
	await writeFile(join(dir, "pending-packages.json"), plan);
	const identity: RecoveryIdentity = {
		agentSha256: sha256(agent),
		planSha256: sha256(plan),
		bootId: "e745eb7a-8c31-4a90-9513-71d72f65e480",
		slot: "rootfs.1",
		compatible: "ceralive-rock-5b-plus",
		osVersion: "2026.10.5",
	};
	const flags = {
		root: true,
		stopped: true,
		unitAbsent: true,
		idle: true,
		clean: true,
		unapplied: true,
		lock: true,
	};
	const probes: RecoveryProbes = {
		root: () => flags.root,
		backendStopped: async () => flags.stopped,
		unitAbsent: async () => flags.unitAbsent,
		operationsIdle: async () => flags.idle,
		dpkgClean: async () => flags.clean,
		identity: async () => ({
			bootId: identity.bootId,
			slot: "rootfs.1",
			compatible: "ceralive-rock-5b-plus",
			osVersion: "2026.10.5",
		}),
		candidateUnapplied: async () => flags.unapplied,
	};
	const deps: RecoveryDeps = {
		store: fileRecoveryStore(dir),
		probes,
		now: () => 20,
		withLock: async (op) => {
			if (!flags.lock) throw new RecoveryRefusal("lock_busy");
			return op();
		},
	};
	return {
		dir,
		identity,
		deps,
		flags,
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
