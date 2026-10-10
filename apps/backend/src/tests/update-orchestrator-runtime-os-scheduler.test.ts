/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The effects/runtime layer (Todo 36) — the three operator RPC actions and the
 * invariant the plan calls out explicitly: `installUpdatesNow` bypasses IDLE
 * but NEVER bypasses the D8 stream-admission block.
 */

/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/
/**
 * The effects/runtime layer (Todo 36) — the three operator RPC actions and the
 * invariant the plan calls out explicitly: `installUpdatesNow` bypasses IDLE
 * but NEVER bypasses the D8 stream-admission block.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { OrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import {
	harness,
	MIN,
	manifest,
	noticeId,
	osNotices,
	T0,
} from "./helpers/orchestrator-runtime-os-scheduler.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("OS staging recovery in the scheduler", () => {
	afterEach(() => {
		for (const notice of getPersistentNotifications(true).show)
			if (notice.name.startsWith("update:")) notificationRemove(notice.name);
	});

	test("the attempt identity is persisted before the stage runs", async () => {
		let persistedAtStage: OrchestratorState | undefined;
		let controlAttempt: string | undefined;
		const persisted: OrchestratorState[] = [];
		harness([], {
			newOsAttemptId: () => "00000000-0000-4000-8000-000000000099",
			persist: (state) => persisted.push(state),
			stageOs: async (_manifest, _progress, control) => {
				persistedAtStage = persisted.at(-1);
				controlAttempt = control?.attemptId;
			},
		});
		await runOrchestratorTick();
		expect(controlAttempt).toBe("00000000-0000-4000-8000-000000000099");
		expect(persistedAtStage?.phase).toBe("os-staging");
		expect(persistedAtStage?.osStageRecovery?.activeAttemptId).toBe(
			"00000000-0000-4000-8000-000000000099",
		);
		expect(getOrchestratorState().phase).toBe("os-staged");
		expect(getOrchestratorState().osStageRecovery).toBeUndefined();
	});

	test("a transport failure waits for its deadline, re-admits the candidate, then stages once", async () => {
		const h = harness([new OsStageError("os_transport_failed")]);
		await runOrchestratorTick();
		expect(h.calls.stages).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOrchestratorState().osStageRecovery).toMatchObject({
			failedRounds: 1,
			nextRetryAt: T0 + 15 * MIN,
			mode: "automatic",
		});
		expect(osNotices()).toEqual([`update:os-stage-retry:${noticeId}`]);

		h.clock.now = T0 + 15 * MIN - 1;
		await runOrchestratorTick();
		expect(h.calls.stages).toBe(1);

		h.clock.now = T0 + 15 * MIN;
		const checksBefore = h.calls.checks;
		await runOrchestratorTick();
		expect(h.calls.checks).toBe(checksBefore + 1);
		expect(h.calls.stages).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");

		await runOrchestratorTick();
		expect(h.calls.stages).toBe(2);
		expect(getOrchestratorState().phase).toBe("os-staged");
		expect(getOrchestratorState().osStageRecovery).toBeUndefined();
		expect(osNotices()).toEqual([]);
		expect(h.attemptIds).toEqual([
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
		]);
	});

	test("an operator pause never stages automatically; a manual install stages one round", async () => {
		const h = harness([new OsStageError("rauc_install_failed")]);
		await runOrchestratorTick();
		expect(getOrchestratorState().osStageRecovery?.mode).toBe("operator");
		expect(osNotices()).toEqual([`update:os-stage-operator:${noticeId}`]);
		h.clock.now = T0 + 7 * 24 * 60 * MIN;
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(h.calls.stages).toBe(1);
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(h.calls.stages).toBe(2);
		expect(getOrchestratorState().phase).toBe("os-staged");
	});

	test("an unsafe failure is terminal and announced as unresolved", async () => {
		const h = harness([new OsStageError("rauc_recovery_unproven")]);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().osStageRecovery?.mode).toBe("unsafe");
		expect(osNotices()).toEqual([`update:os-stage-unresolved:${noticeId}`]);
		h.clock.now = T0 + 7 * 24 * 60 * MIN;
		await runOrchestratorTick();
		expect(h.calls.stages).toBe(1);
	});

	test("a stream cancellation is not a failed round and raises no notice", async () => {
		harness([new OsStageError("os_stage_cancelled_for_stream")]);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOrchestratorState().osStageRecovery).toMatchObject({
			failedRounds: 0,
			activeAttemptId: null,
		});
		expect(osNotices()).toEqual([]);
	});

	test("staging failures never write quarantine", async () => {
		const h = harness([
			new OsStageError("os_transport_failed"),
			new Error("rauc failed"),
		]);
		await runOrchestratorTick();
		h.clock.now = T0 + 15 * MIN;
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(h.calls.stages).toBe(2);
		expect(getOrchestratorState().phase).toBe("failed");
		expect(await h.quarantine.isOsVersionQuarantined(manifest.version)).toBe(
			false,
		);
	});

	test("a package check and install proceed while the OS stage waits", async () => {
		const h = harness([new OsStageError("os_transport_failed")], {
			getPackageInstallWireState: () => ({
				kind: "available",
				identity: { version: "app-update", packages: ["cerastream"] },
				package_count: 1,
				actionable_count: 1,
				packages: [{ name: "cerastream", layer: "app", actionable: true }],
			}),
		});
		await runOrchestratorTick();
		const waiting = getOrchestratorState().osStageRecovery;
		expect(waiting?.mode).toBe("automatic");
		h.clock.now = T0 + 5 * MIN;
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			packageCheck: {
				...getOrchestratorState().packageCheck,
				nextAttemptAt: 0,
			},
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("available");
		expect(getOrchestratorState().packageCheck.lastSuccessAt).toBe(
			T0 + 5 * MIN,
		);
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(h.calls.installs).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(getOrchestratorState().osStageRecovery).toEqual(waiting);
		expect(h.calls.stages).toBe(1);
	});

	test("a successful OS check of the same candidate cannot reset the stage budget", async () => {
		const h = harness([new OsStageError("os_transport_failed")], {
			runPackageCheck: async () => null,
		});
		await runOrchestratorTick();
		const waiting = getOrchestratorState().osStageRecovery;
		h.clock.now = T0 + MIN;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOrchestratorState().osCheck.lastSuccessAt).toBe(T0 + MIN);
		expect(getOrchestratorState().osStageRecovery).toEqual(waiting);
		await runOrchestratorTick();
		expect(h.calls.stages).toBe(1);
	});
});
