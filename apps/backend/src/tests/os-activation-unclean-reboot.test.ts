/**
 * An unclean reboot while an OS activation is armed is NOT a rollback.
 *
 * Replays the Rock 5B+ crash of 2026-09-30 (task-45x/rock F15): 2026.10.31 was
 * staged into slot A and armed, then a `sysrq b` reset rebooted slot B before
 * the clean-shutdown hook could run `rauc status mark-active other`. The boot
 * id changed, the booted CalVer was still 2026.10.30, and the orchestrator
 * quarantined a version that had never booted. Only a reboot that followed a
 * real activation may be judged against the staged version.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebindStagedReceipt } from "../modules/system/update-orchestrator/os-agent.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	type defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { parseStagedActivation } from "../modules/system/update-orchestrator/slot-status.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";

const FIXTURE_DIR = `${import.meta.dir}/fixtures/rauc`;
// JSON form of the post-crash `rauc status --detailed` in e-37-postcrash.txt.
const crashRauc = await Bun.file(
	`${FIXTURE_DIR}/status-detailed-rock-5b-plus-rauc-1.15-crash-armed.txt`,
).text();

const PRE_CRASH_BOOT = "704ce001-1dce-4eba-b911-ec390923f270";
const POST_CRASH_BOOT = "0b3c1676-a8be-4b82-bebe-5cc7ea99ef0f";

type Deps = Partial<typeof defaultOrchestratorRuntimeDeps>;
type CrashDocument = {
	boot_primary?: string;
	slots: Record<
		string,
		{ slot_status: Record<string, unknown> | null } | undefined
	>[];
};

function otherSlot(document: CrashDocument): {
	slot_status: Record<string, unknown> | null;
} {
	const slot = document.slots.find((item) => "rootfs.0" in item)?.["rootfs.0"];
	if (!slot) throw new Error("fixture has no rootfs.0");
	return slot;
}

function armedAt(version: string): {
	readonly rollbacks: string[];
	readonly rebinds: string[];
	readonly retired: string[];
	readonly persisted: OrchestratorState[];
	readonly deps: Deps;
} {
	const rollbacks: string[] = [];
	const rebinds: string[] = [];
	const retired: string[] = [];
	const persisted: OrchestratorState[] = [];
	class RecordingQuarantine extends UpdateQuarantine {
		override async recordOsRollback(expected: string): Promise<void> {
			rollbacks.push(expected);
		}
	}
	const receipt = {
		schema: 1 as const,
		version,
		channel: "drill" as const,
		stagedAt: 1_790_757_533_377,
		bootId: PRE_CRASH_BOOT,
	};
	const deps: Deps = {
		now: () => 1_790_757_790_225,
		isStreamLive: () => false,
		armOs: async () => {},
		readOsReceipt: async () => receipt,
		readBootId: async () => POST_CRASH_BOOT,
		readBootedVersion: async () => "2026.10.30",
		rebindOsReceipt: async (_receipt, bootId) => {
			rebinds.push(bootId);
		},
		retireOsReceipt: (staged) => {
			retired.push(staged.version);
			return true;
		},
		quarantine: new RecordingQuarantine(),
		persist: (state) => {
			persisted.push(state);
		},
	};
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-activation-armed",
	});
	return { rollbacks, rebinds, retired, persisted, deps };
}

function rollbackNotices(version: string): number {
	return getPersistentNotifications(true).show.filter(
		(item) => item.name === `update:os-rollback:${version}`,
	).length;
}

afterEach(() => resetOrchestratorRuntimeForTest());

describe("boot-id change while os-activation-armed", () => {
	test("a crash reboot before activation stays armed and rebinds the receipt", async () => {
		const run = armedAt("2026.10.31");
		setOrchestratorRuntimeDepsForTest({
			...run.deps,
			readStagedActivation: async () => parseStagedActivation(crashRauc),
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-activation-armed");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(run.rollbacks).toEqual([]);
		expect(rollbackNotices("2026.10.31")).toBe(0);
		expect(run.persisted).toEqual([]);
		expect(run.rebinds).toEqual([POST_CRASH_BOOT]);
		// The still-staged candidate's receipt survives the crash reboot.
		expect(run.retired).toEqual([]);
	});

	test("unreadable RAUC status reaches no verdict and retries next tick", async () => {
		const run = armedAt("2026.10.41");
		setOrchestratorRuntimeDepsForTest({
			...run.deps,
			readStagedActivation: async () => {
				throw new Error("rauc status failed");
			},
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-activation-armed");
		expect(run.rollbacks).toEqual([]);
		expect(rollbackNotices("2026.10.41")).toBe(0);
		expect(run.persisted).toEqual([]);
		expect(run.rebinds).toEqual([]);
	});

	test("an unusable RAUC document is treated like an unreadable one", async () => {
		const run = armedAt("2026.10.42");
		setOrchestratorRuntimeDepsForTest({
			...run.deps,
			readStagedActivation: async () => "unknown",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-activation-armed");
		expect(run.rollbacks).toEqual([]);
		expect(run.persisted).toEqual([]);
		expect(run.rebinds).toEqual([]);
	});

	test("missing activation evidence neither quarantines nor rebinds", async () => {
		const withoutEvidence: ReadonlyArray<
			readonly [string, (document: CrashDocument) => void]
		> = [
			[
				"other-slot status unavailable",
				(document) => {
					otherSlot(document).slot_status = null;
				},
			],
			[
				"install without a timestamp",
				(document) => {
					const status = otherSlot(document).slot_status;
					if (status) status.installed = { count: 3 };
				},
			],
			[
				"primary names no rootfs slot",
				(document) => {
					document.boot_primary = "certs.0";
				},
			],
		];
		for (const [label, damage] of withoutEvidence) {
			resetOrchestratorRuntimeForTest();
			const run = armedAt("2026.10.31");
			const document: CrashDocument = JSON.parse(crashRauc);
			damage(document);
			const status = JSON.stringify(document);
			setOrchestratorRuntimeDepsForTest({
				...run.deps,
				readStagedActivation: async () => parseStagedActivation(status),
			});
			await runOrchestratorTick();
			expect({ label, phase: getOrchestratorState().phase }).toEqual({
				label,
				phase: "os-activation-armed",
			});
			expect(getOrchestratorState().failureReason).toBeNull();
			expect(run.rollbacks).toEqual([]);
			expect(rollbackNotices("2026.10.31")).toBe(0);
			expect(run.persisted).toEqual([]);
			expect(run.rebinds).toEqual([]);
		}
	});

	test("a mismatch after a real activation is still a rollback", async () => {
		const run = armedAt("2026.10.43");
		setOrchestratorRuntimeDepsForTest({
			...run.deps,
			readStagedActivation: async () => "consumed",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("quarantined");
		expect(getOrchestratorState().failureReason).toBe("os_version_mismatch");
		expect(run.rollbacks).toEqual(["2026.10.43"]);
		expect(rollbackNotices("2026.10.43")).toBe(1);
		expect(run.rebinds).toEqual([]);
	});

	// Booting the staged version no longer verifies by itself (task-45 opi-r5
	// C1); it needs this boot's healthcheck verdict. Either way, RAUC's
	// activation state is not consulted once the staged CalVer is booted.
	test("booting the staged version without this boot's healthcheck verdict waits, without consulting RAUC", async () => {
		const run = armedAt("2026.10.30");
		let raucReads = 0;
		setOrchestratorRuntimeDepsForTest({
			...run.deps,
			readStagedActivation: async () => {
				raucReads += 1;
				return "unknown";
			},
			readHealthyState: async () => null,
			startSlotSync: async () => {},
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(run.persisted.map((state) => state.phase)).toEqual(["os-verifying"]);
		expect(run.rollbacks).toEqual([]);
		expect(raucReads).toBe(0);
		// Verification still owns the receipt of the version it is judging.
		expect(run.retired).toEqual([]);
	});

	test("booting the staged version with this boot's healthcheck verdict verifies, without consulting RAUC", async () => {
		const run = armedAt("2026.10.30");
		let raucReads = 0;
		setOrchestratorRuntimeDepsForTest({
			...run.deps,
			readStagedActivation: async () => {
				raucReads += 1;
				return "unknown";
			},
			readHealthyState: async () => ({
				boot_id: POST_CRASH_BOOT,
				slot: "A",
				build_id: "build",
				dpkg_status_sha256: "a".repeat(64),
				recorded_at: "2026-09-30T00:00:00Z",
			}),
			startSlotSync: async () => {},
		});
		await runOrchestratorTick();
		expect(run.persisted.map((state) => state.phase)).toContain(
			"sync-eligible",
		);
		expect(run.rollbacks).toEqual([]);
		expect(raucReads).toBe(0);
	});
});

describe("rebindStagedReceipt", () => {
	test("moves only the boot id, keeping the seven-day clock", async () => {
		const dir = await mkdtemp(join(tmpdir(), "os-rebind-"));
		try {
			const staged = {
				schema: 1 as const,
				version: "2026.10.31",
				channel: "drill" as const,
				stagedAt: 1_790_757_533_377,
				bootId: PRE_CRASH_BOOT,
			};
			await rebindStagedReceipt(staged, POST_CRASH_BOOT, dir);
			expect(await Bun.file(join(dir, "os-staged.json")).json()).toEqual({
				...staged,
				bootId: POST_CRASH_BOOT,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
