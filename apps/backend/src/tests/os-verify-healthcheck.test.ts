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
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { HealthySlotState } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { slotSyncGate } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
} from "../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";

const V2 = "2026.10.34";
// Stage boot (v2, slot B); also the boot the stale healthy record names.
const STAGE_BOOT = "cff0545c-a018-4f1b-b3ac-4848ed7a0f19";
const V3_BOOTS = [
	"01709e76-b42a-4d98-9145-d36a01782d14",
	"df148bca-d0d5-47ba-b50b-72cfcd61d54f",
	"e5c0d9a4-2fe8-402c-afc8-4ccde133c902",
] as const;
const FALLBACK_BOOT = "d5d01051-93b7-48f6-8333-8af6a33e438c";

function healthyFor(bootId: string): HealthySlotState {
	return {
		boot_id: bootId,
		slot: "B",
		build_id: "36d8131819aa4eb0b46666b76c702db0afada938",
		dpkg_status_sha256:
			"e2c2a979007aa076e32f724c2c386bdd4c661fd2bd817891244c064f68116cc2",
		recorded_at: "2026-09-30T19:07:25Z",
	};
}

type Board = {
	bootId: string;
	bootedVersion: string | undefined;
	healthy: HealthySlotState | null | Error;
	bootIdError: Error | null;
};

// Records rollbacks without touching /data; the drill replay uses a real file.
class MemoryQuarantine extends UpdateQuarantine {
	readonly rollbacks: string[] = [];
	override async recordOsRollback(expected: string): Promise<void> {
		this.rollbacks.push(expected);
	}
}

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

/**
 * A board whose boot id, booted CalVer and healthy record the test moves
 * between "boots". `staged` is unique per test so the module-global
 * notification store cannot leak between cases.
 */
function board(staged: string, start: Partial<Board> = {}) {
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
		now: () => 1_790_803_448_030,
		isStreamLive: () => false,
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
		}),
		armOs: async () => {},
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
		startSlotSync: async () => {},
		persist: (next) => {
			phases.push(next.phase);
		},
		quarantine: new MemoryQuarantine(),
	} satisfies typeof defaultOrchestratorRuntimeDeps;
	return { now, deps, healthReads, phases };
}

function notices(kind: "os-activated" | "os-rollback", version: string) {
	return getPersistentNotifications(true).show.filter(
		(item) => item.name === `update:${kind}:${version}`,
	).length;
}

function verifying(): void {
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-verifying",
	});
}

async function useStateFile(): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "ceraui-os-verify-"));
	const path = join(root, "agent.json");
	setOrchestratorStateFilePathForTest(path);
	return path;
}

describe("os-verifying waits for this boot's healthcheck verdict", () => {
	test("booted == staged with no healthy record stays os-verifying, silently", async () => {
		const b = board("2026.10.101", { healthy: null });
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(b.phases).toEqual([]);
		expect(notices("os-activated", "2026.10.101")).toBe(0);
		expect(notices("os-rollback", "2026.10.101")).toBe(0);
	});

	test("booted == staged with this boot's healthy record verifies and notifies", async () => {
		const b = board("2026.10.102", { healthy: healthyFor(V3_BOOTS[0]) });
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		// OS_VERIFIED enters sync-eligible; the mirror attempt then moves on.
		expect(b.phases).toEqual(["sync-eligible", "idle"]);
		expect(notices("os-activated", "2026.10.102")).toBe(1);
		expect(notices("os-rollback", "2026.10.102")).toBe(0);
	});

	test("the previous boot's healthy record does not verify this boot", async () => {
		// Exactly the board's state on every failing v3 boot.
		const b = board("2026.10.103", { healthy: healthyFor(STAGE_BOOT) });
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(b.phases).toEqual([]);
		expect(notices("os-activated", "2026.10.103")).toBe(0);
	});

	test("a garbled healthy record or an unreadable boot id defers without throwing", async () => {
		const unreadable: ReadonlyArray<readonly [string, Partial<Board>]> = [
			["garbled healthy record", { healthy: new Error("schema_invalid") }],
			[
				"boot id unreadable",
				{
					healthy: healthyFor(V3_BOOTS[0]),
					bootIdError: new Error("boot_id_unknown"),
				},
			],
		];
		for (const [label, start] of unreadable) {
			resetOrchestratorRuntimeForTest();
			const version = `2026.10.${label.length + 110}`;
			const b = board(version, start);
			setOrchestratorRuntimeDepsForTest(b.deps);
			verifying();
			await runOrchestratorTick();
			expect({ label, phase: getOrchestratorState().phase }).toEqual({
				label,
				phase: "os-verifying",
			});
			expect(notices("os-activated", version)).toBe(0);
		}
	});

	test("a healthy record written between two ticks verifies on the next tick", async () => {
		const b = board("2026.10.104", { healthy: healthyFor(STAGE_BOOT) });
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		await runOrchestratorTick(); // healthcheck still running
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(b.phases).toEqual([]);
		b.now.healthy = healthyFor(V3_BOOTS[0]);
		await runOrchestratorTick();
		expect(b.phases[0]).toBe("sync-eligible");
		expect(notices("os-activated", "2026.10.104")).toBe(1);
	});

	test("the reboot into the staged slot defers verification in the same tick", async () => {
		const b = board("2026.10.105", { healthy: null });
		setOrchestratorRuntimeDepsForTest(b.deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(notices("os-activated", "2026.10.105")).toBe(0);
	});

	test("a rollback is judged before and without the healthy record", async () => {
		const b = board("2026.10.106", {
			bootedVersion: V2,
			healthy: new Error("must not be needed"),
		});
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("quarantined");
		expect(b.healthReads).toEqual([]);
	});

	test("an unreadable booted version stays os-verifying, as before", async () => {
		const b = board("2026.10.107", {
			bootedVersion: undefined,
			healthy: healthyFor(V3_BOOTS[0]),
		});
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(notices("os-activated", "2026.10.107")).toBe(0);
	});
});

describe("drill A2 replay: boots that fail their healthcheck, then the fallback", () => {
	test("v3 failing three boots then v2 is recorded as a rollback and never re-offered", async () => {
		const v3 = "2026.10.35";
		const statePath = await useStateFile();
		const dir = dirname(statePath);
		const quarantinePath = join(dir, "quarantine.json");
		const quarantine = new UpdateQuarantine(quarantinePath, async () => {});
		const b = board(v3, { healthy: healthyFor(STAGE_BOOT) });
		const deps = { ...b.deps, quarantine, persist: saveOrchestratorState };
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});

		// Boot 1 of v3: the backend comes up before the healthcheck refuses.
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");

		// The healthcheck failed (no `mark-good`, no new record); boots 2 and 3
		// are each a backend restart on the same failing slot.
		for (const bootId of V3_BOOTS.slice(1)) {
			resetOrchestratorRuntimeForTest();
			setOrchestratorStateFilePathForTest(statePath);
			b.now.bootId = bootId;
			await startUpdateOrchestrator(deps);
			expect({ bootId, phase: getOrchestratorState().phase }).toEqual({
				bootId,
				phase: "os-verifying",
			});
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("os-verifying");
		}
		expect(notices("os-activated", v3)).toBe(0);
		expect(await quarantine.isOsVersionQuarantined(v3)).toBe(false);

		// Boot 4: the counter ran out and U-Boot started v2 from slot B, whose
		// own healthcheck may already have written a record for this boot.
		resetOrchestratorRuntimeForTest();
		setOrchestratorStateFilePathForTest(statePath);
		b.now.bootId = FALLBACK_BOOT;
		b.now.bootedVersion = V2;
		b.now.healthy = healthyFor(FALLBACK_BOOT);
		await startUpdateOrchestrator(deps);

		expect(getOrchestratorState().phase).toBe("quarantined");
		expect(getOrchestratorState().failureReason).toBe("os_version_mismatch");
		expect(await Bun.file(quarantinePath).json()).toMatchObject({
			os: [{ version: v3, bootedVersion: V2 }],
		});
		expect(notices("os-rollback", v3)).toBe(1);
		expect(notices("os-activated", v3)).toBe(0);
		expect(await Bun.file(statePath).json()).toMatchObject({
			phase: "quarantined",
		});

		// The OS check refuses the same candidate through the real quarantine.
		const manifest = {
			schema: 1,
			board: "orange-pi-5-plus",
			compatible: "ceralive-orangepi5-plus",
			channel: "stable",
			version: v3,
			serial: 10,
			published_at: "2026-09-30T12:00:00Z",
			expires_at: "2026-12-30T12:00:00Z",
			os_version_id: "13",
			min_ceraui_version: "2026.9.3",
			bundle: {
				url: `https://images.ceralive.tv/releases/orange-pi-5-plus/${v3}/bundle.raucb`,
				size: 1_464_368_631,
				sha256: "a".repeat(64),
			},
			flash: {
				url: `https://images.ceralive.tv/releases/orange-pi-5-plus/${v3}/flash.raw.xz`,
				size: 10,
				sha256: "b".repeat(64),
				raw_sha256: "c".repeat(64),
			},
			lock_url: `https://images.ceralive.tv/releases/orange-pi-5-plus/${v3}/packages.lock.json`,
		};
		const judge = (isQuarantined: (version: string) => Promise<boolean>) =>
			validateSignedOsManifest(
				new TextEncoder().encode(JSON.stringify(manifest)),
				new Uint8Array([1]),
				{
					board: "orange-pi-5-plus",
					compatible: "ceralive-orangepi5-plus",
					channel: "stable",
					serial: 9,
					bootedVersion: V2,
					installedVersion: "2026.9.5",
					now: Date.parse("2026-10-01T08:27:00Z"),
				},
				{
					verifyCms: async () => ({
						cn: "CeraLive OTA Manifest Signer",
						eku: ["codeSigning"],
						issuer: "CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive",
					}),
					compare: async (a, b2) =>
						Bun.spawnSync(["dpkg", "--compare-versions", a, "gt", b2])
							.exitCode === 0,
					isQuarantined,
				},
			);
		expect(
			await judge((version) => quarantine.isOsVersionQuarantined(version)),
		).toEqual({ ok: false, reason: "version_quarantined" });
		// Non-vacuity: the same manifest is offered when nothing is quarantined.
		const empty = new UpdateQuarantine(
			join(dir, "empty-quarantine.json"),
			async () => {},
		);
		expect(
			await judge((version) => empty.isOsVersionQuarantined(version)),
		).toMatchObject({ ok: true });
	});

	test("a restart between the boot and a passing healthcheck still verifies", async () => {
		const statePath = await useStateFile();
		const b = board("2026.10.108", { healthy: healthyFor(STAGE_BOOT) });
		const deps = { ...b.deps, persist: saveOrchestratorState };
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-verifying");

		// G1: the hostname reconcile restarts ceralive.service on the same boot.
		resetOrchestratorRuntimeForTest();
		setOrchestratorStateFilePathForTest(statePath);
		await startUpdateOrchestrator(deps);
		expect(getOrchestratorState().phase).toBe("os-verifying");

		b.now.healthy = healthyFor(V3_BOOTS[0]);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).not.toBe("os-verifying");
		expect(notices("os-activated", "2026.10.108")).toBe(1);
		expect(notices("os-rollback", "2026.10.108")).toBe(0);
	});
});

describe("os-verifying keeps its other semantics while it waits", () => {
	test("stream admission, manual actions and the slot-sync gate are unchanged", async () => {
		const b = board("2026.10.109", { healthy: null });
		setOrchestratorRuntimeDepsForTest(b.deps);
		verifying();
		await runOrchestratorTick();
		const phase: OrchestratorPhase = "os-verifying";
		expect(getOrchestratorState().phase).toBe(phase);
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		expect(getOrchestratorState().phase).toBe(phase);
		expect(await installUpdatesNow()).toMatchObject({ started: false });
		expect(await checkUpdatesNow()).toEqual({
			started: false,
			reason: "busy",
		});
		expect(getOrchestratorState().phase).toBe(phase);
		expect(
			slotSyncGate({
				healthyState: healthyFor(V3_BOOTS[0]),
				bootId: V3_BOOTS[0],
				statusSha256: healthyFor(V3_BOOTS[0]).dpkg_status_sha256,
				buildId: "36d8131819aa4eb0b46666b76c702db0afada938",
				receiptStateSha256: null,
				receiptTarget: "not-other",
				receiptTargetSlot: null,
				capabilities: {
					mode: "capable",
					features: ["apt-all-packages", "slot-sync"],
				},
				phase,
			}),
		).toEqual({ allowed: false, reason: "os-install-pending" });
	});
});
