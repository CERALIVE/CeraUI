/**
 * An OS update is verified by THIS boot's healthcheck verdict, not by the
 * booted CalVer alone.
 *
 * Replays Orange Pi 5+ drill A part 2 (task-45 opi-r5, finding C1): v3-bad
 * 2026.10.35 was staged into slot A from v2 2026.10.34 on slot B. Slot A booted
 * v3 three times, each healthcheck refused `mark-good`, and the fourth boot came
 * up on v2. The orchestrator declared the first v3 boot verified three seconds
 * after it started, so the later fallback was never recorded as a rollback. The
 * boot ids and the healthy record below are the ones captured on the board.
 */
import { UpdateQuarantine } from "../../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type { HealthySlotState } from "../../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
} from "../../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../../modules/ui/notifications.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const V2 = "2026.10.34";

export const STAGE_BOOT = "cff0545c-a018-4f1b-b3ac-4848ed7a0f19";

export const V3_BOOTS = [
	"01709e76-b42a-4d98-9145-d36a01782d14",
	"df148bca-d0d5-47ba-b50b-72cfcd61d54f",
	"e5c0d9a4-2fe8-402c-afc8-4ccde133c902",
] as const;

export const FALLBACK_BOOT = "d5d01051-93b7-48f6-8333-8af6a33e438c";

export function healthyFor(bootId: string): HealthySlotState {
	return {
		boot_id: bootId,
		slot: "B",
		build_id: "36d8131819aa4eb0b46666b76c702db0afada938",
		dpkg_status_sha256:
			"e2c2a979007aa076e32f724c2c386bdd4c661fd2bd817891244c064f68116cc2",
		recorded_at: "2026-09-30T19:07:25Z",
	};
}

export type Board = {
	bootId: string;
	bootedVersion: string | undefined;
	healthy: HealthySlotState | null | Error;
	bootIdError: Error | null;
};

export class MemoryQuarantine extends UpdateQuarantine {
	readonly rollbacks: string[] = [];
	override async recordOsRollback(expected: string): Promise<void> {
		this.rollbacks.push(expected);
	}
}

export function board(staged: string, start: Partial<Board> = {}) {
	const now: Board = {
		bootId: V3_BOOTS[0],
		bootedVersion: staged,
		healthy: healthyFor(STAGE_BOOT),
		bootIdError: null,
		...start,
	};
	const healthReads: string[] = [];
	const phases: OrchestratorPhase[] = [];
	const receipt = {
		schema: 1 as const,
		version: staged,
		channel: "drill" as const,
		stagedAt: 1_790_803_104_176,
		bootId: STAGE_BOOT,
	};
	const deps = {
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		now: () => 1_790_803_448_030,
		isStreamLive: () => false,
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
		}),
		armOs: async () => {
			// Verification fixtures must not arm a host slot.
		},
		readOsReceipt: async () => receipt,
		readStagedActivation: async () => "consumed",
		readBootId: async () => {
			if (now.bootIdError) throw now.bootIdError;
			return now.bootId;
		},
		readBootedVersion: async () => now.bootedVersion,
		readHealthyState: async () => {
			healthReads.push(now.bootId);
			if (now.healthy instanceof Error) throw now.healthy;
			return now.healthy;
		},
		// Slot-sync is not under test; keep it out of the file system.
		readSlotSyncEvidence: async () => {
			throw new Error("slot-sync evidence not under test");
		},
		startSlotSync: async () => {
			// The healthy-state verdict is under test, not the host mirror.
		},
		persist: (next) => {
			phases.push(next.phase);
		},
		quarantine: new MemoryQuarantine(),
	} satisfies typeof defaultOrchestratorRuntimeDeps;
	return { now, deps, healthReads, phases };
}

export function notices(kind: "os-activated" | "os-rollback", version: string) {
	return getPersistentNotifications(true).show.filter(
		(item) => item.name === `update:${kind}:${version}`,
	).length;
}

export function verifying(): void {
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-verifying",
	});
}
