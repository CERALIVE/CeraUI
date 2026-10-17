import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import { osChannelManifestSchema } from "../../modules/system/update-orchestrator/os-manifest.ts";
import { osStageCandidateKey } from "../../modules/system/update-orchestrator/os-stage-retry.ts";
import type { RootSlotStatus } from "../../modules/system/update-orchestrator/slot-status.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";

export const NOW = 50_000_000;

export const BOOT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const manifest = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
});

export const KEY = osStageCandidateKey(manifest);

export const R6_SLOTS: readonly RootSlotStatus[] = [
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
];

export type Evidence = {
	operation: "idle" | "running" | "unreadable";
	quiescent: boolean;
	slots: readonly RootSlotStatus[];
	receipt: boolean;
	armed: boolean;
};

export const PROOF: Evidence = {
	operation: "idle",
	quiescent: true,
	slots: R6_SLOTS,
	receipt: false,
	armed: false,
};

export const LEGACY_R6: OrchestratorState = {
	...initialOrchestratorState(0),
	phase: "failed",
	failureReason: "rauc_install_failed",
};

export function unsafeRecord(): OsStageRecovery {
	return {
		candidateKey: KEY,
		activeAttemptId: null,
		failedRounds: 1,
		nextRetryAt: null,
		mode: "unsafe",
		reason: "rauc_recovery_unproven",
	};
}
