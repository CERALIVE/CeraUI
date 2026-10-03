import { afterEach, expect, test } from "bun:test";
import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import {
	osStageCandidateKey,
	osStageNoticeId,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import {
	cleanupRecovery,
	deferred,
	manifest,
	recoveryHarness,
	T0,
} from "./helpers/os-recovery-harness.ts";

afterEach(cleanupRecovery);

test.each(["active before check", "rejected after evidence"] as const)(
	"H2-R3 retains unresolved notice when confirmation is %s",
	async (interleaving) => {
		// Given an unsafe record with its exact candidate's standing notice.
		const key = osStageCandidateKey(manifest);
		const record: OsStageRecovery = {
			candidateKey: key,
			activeAttemptId: interleaving === "active before check" ? "orphan" : null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: "unsafe",
			reason: "rauc_recovery_unproven",
		};
		const entered = deferred<void>();
		const release = deferred<void>();
		let probes = 0;
		let authoritative: ReturnType<typeof getOrchestratorState> | null = null;
		await recoveryHarness({
			readPersistedState: async () => authoritative,
			inspectOsOperation: async () => {
				probes++;
				entered.resolve();
				await release.promise;
				return "idle";
			},
			proveOsWriterQuiescent: async () => true,
			readActivationArmed: async () => false,
			readOsReceipt: async () => undefined,
			readBootId: async () => "boot",
			readHealthyState: async () => ({
				boot_id: "boot",
				slot: "A",
				build_id: "b",
				dpkg_status_sha256: "d".repeat(64),
				recorded_at: "2026-10-01T00:00:00Z",
			}),
			readRootSlots: async () => [
				{
					name: "rootfs.0",
					bootname: "A",
					state: "booted",
					bootStatus: "good",
					version: null,
					lastSyncedAt: null,
				},
				{
					name: "rootfs.1",
					bootname: "B",
					state: "inactive",
					bootStatus: "bad",
					version: null,
					lastSyncedAt: null,
				},
			],
			now: () => {
				if (interleaving === "rejected after evidence" && probes > 0)
					record.activeAttemptId = "orphan";
				return T0;
			},
		});
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			phase: "failed",
			failureReason: record.reason,
			osStageRecovery: record,
		});
		authoritative = structuredClone(getOrchestratorState());
		const name = `update:os-stage-unresolved:${osStageNoticeId(key)}`;
		notifyUpdate({
			kind: "os-stage-unresolved",
			id: osStageNoticeId(key),
			version: manifest.version,
		});
		// When confirmation is inadmissible at entry or rejected at dispatch.
		const check = checkUpdatesNow();
		try {
			if (interleaving === "rejected after evidence") await entered.promise;
			release.resolve();
			expect(await check).toEqual({ started: false, reason: "busy" });
			// Then only an accepted confirmation may retract the unresolved claim.
			expect(
				getPersistentNotifications(true).show.map((notice) => notice.name),
			).toContain(name);
			expect(getOrchestratorState().phase).toBe("failed");
			expect(probes).toBe(interleaving === "active before check" ? 0 : 1);
		} finally {
			release.resolve();
			await check;
		}
	},
);
