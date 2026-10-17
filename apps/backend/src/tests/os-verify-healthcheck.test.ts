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
import { rm } from "node:fs/promises";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { slotSyncGate } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
} from "../modules/system/update-orchestrator/types.ts";
import {
	type Board,
	board,
	healthyFor,
	notices,
	STAGE_BOOT,
	V2,
	V3_BOOTS,
	verifying,
} from "./helpers/os-verify-healthcheck-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

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
