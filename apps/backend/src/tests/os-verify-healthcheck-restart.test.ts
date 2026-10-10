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
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	board,
	FALLBACK_BOOT,
	healthyFor,
	notices,
	STAGE_BOOT,
	V2,
	V3_BOOTS,
} from "./helpers/os-verify-healthcheck-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function useStateFile(): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "ceraui-os-verify-"));
	const path = join(root, "agent.json");
	setOrchestratorStateFilePathForTest(path);
	return path;
}

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

	test("a backend start on the first boot of the new slot waits for its healthcheck", async () => {
		const statePath = await useStateFile();
		const b = board("2026.10.110", { healthy: healthyFor(STAGE_BOOT) });
		const deps = { ...b.deps, persist: saveOrchestratorState };
		saveOrchestratorState({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await startUpdateOrchestrator(deps);
		expect(getOrchestratorState().phase).toBe("os-verifying");
		expect(await Bun.file(statePath).json()).toMatchObject({
			phase: "os-verifying",
		});
		expect(notices("os-activated", "2026.10.110")).toBe(0);
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
