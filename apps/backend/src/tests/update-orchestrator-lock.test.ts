/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * `/run/lock/ceralive-update.lock` sharing (Todo 36) — slot-sync probe parsing
 * and the lock-contention proof. Real slot-sync's `run` subcommand takes the
 * SAME lock non-blockingly (`flock -n`) and exits 75 (EX_REFUSE) on contention
 * — see `ceralive-slot-sync.sh` in image-building-pipeline (read-only
 * reference). This suite proves our probe correctly distinguishes that
 * refusal from every other outcome using only `systemctl show`-shaped text,
 * with no real device/systemd required.
 */

import { describe, expect, test } from "bun:test";
import { SOFTWARE_UPDATE_LOCK as SHARED_LOCK_CONSTANT } from "../modules/system/software-update-service-contract.ts";
import {
	parseSlotSyncProbe,
	SLOT_SYNC_REFUSE_EXIT_CODE,
	SOFTWARE_UPDATE_LOCK,
} from "../modules/system/update-orchestrator/lock.ts";

function fixture(props: Record<string, string>): string {
	return Object.entries(props)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
}

describe("lock.ts — the slot-sync lock path is Todo 35's SAME constant, not a second literal", () => {
	test("SOFTWARE_UPDATE_LOCK is re-exported, not redefined", () => {
		expect(SOFTWARE_UPDATE_LOCK).toBe(SHARED_LOCK_CONSTANT);
		expect(SOFTWARE_UPDATE_LOCK).toBe("/run/lock/ceralive-update.lock");
	});
});

describe("parseSlotSyncProbe — unit lifecycle states", () => {
	test("LoadState != loaded -> absent (unit file not installed, or genuinely never run)", () => {
		expect(parseSlotSyncProbe(fixture({ LoadState: "not-found" }))).toEqual({
			kind: "absent",
		});
	});

	test("active/activating -> running", () => {
		for (const activeState of [
			"active",
			"activating",
			"reloading",
			"deactivating",
		]) {
			expect(
				parseSlotSyncProbe(
					fixture({
						LoadState: "loaded",
						ActiveState: activeState,
						SubState: "start",
					}),
				),
			).toEqual({ kind: "running" });
		}
	});

	test("inactive/dead with no prior run recorded (empty ExecMainCode) -> absent", () => {
		expect(
			parseSlotSyncProbe(
				fixture({
					LoadState: "loaded",
					ActiveState: "inactive",
					SubState: "dead",
					ExecMainCode: "0",
					ExecMainStatus: "0",
				}),
			),
		).toEqual({ kind: "absent" });
	});

	test("inactive/dead with a recorded successful run (CLD_EXITED, status 0) -> succeeded", () => {
		expect(
			parseSlotSyncProbe(
				fixture({
					LoadState: "loaded",
					ActiveState: "inactive",
					SubState: "dead",
					ExecMainCode: "1",
					ExecMainStatus: "0",
				}),
			),
		).toEqual({ kind: "succeeded" });
	});

	test("ActiveState=failed with ExecMainStatus=75 (EX_REFUSE) -> refused, exposing the exit code", () => {
		expect(
			parseSlotSyncProbe(
				fixture({
					LoadState: "loaded",
					ActiveState: "failed",
					SubState: "failed",
					ExecMainCode: "1",
					ExecMainStatus: "75",
				}),
			),
		).toEqual({ kind: "refused", exitCode: 75 });
		expect(SLOT_SYNC_REFUSE_EXIT_CODE).toBe(75);
	});

	test("ActiveState=failed with any OTHER non-zero exit -> failed (operational failure), not refused", () => {
		expect(
			parseSlotSyncProbe(
				fixture({
					LoadState: "loaded",
					ActiveState: "failed",
					SubState: "failed",
					ExecMainCode: "1",
					ExecMainStatus: "1",
				}),
			),
		).toEqual({ kind: "failed", exitCode: 1 });
	});

	test("SIGTERM (CLD_KILLED=2, signal 15) maps through the shared shell-style conversion to exit 143 -> failed", () => {
		expect(
			parseSlotSyncProbe(
				fixture({
					LoadState: "loaded",
					ActiveState: "failed",
					SubState: "failed",
					ExecMainCode: "2",
					ExecMainStatus: "15",
				}),
			),
		).toEqual({ kind: "failed", exitCode: 143 });
	});

	test("a refused run recorded via the SAME failed-unit shape as any other failure is still correctly split out by exit code", () => {
		// Exhaustive: every exit code except 75 is "failed"; exactly 75 is "refused".
		for (const status of [1, 2, 74, 76, 143]) {
			const result = parseSlotSyncProbe(
				fixture({
					LoadState: "loaded",
					ActiveState: "failed",
					SubState: "failed",
					ExecMainCode: "1",
					ExecMainStatus: String(status),
				}),
			);
			expect(result.kind).toBe("failed");
		}
		const refused = parseSlotSyncProbe(
			fixture({
				LoadState: "loaded",
				ActiveState: "failed",
				SubState: "failed",
				ExecMainCode: "1",
				ExecMainStatus: "75",
			}),
		);
		expect(refused.kind).toBe("refused");
	});
});

describe("lock.ts — structural lock-contention guard (orchestrator level)", () => {
	// The orchestrator's OWN structural guard: slot-sync may only be started
	// from `sync-eligible` (see reducer.ts's `SYNC_STARTED` handler, which is
	// the ONLY transition that fires the effect). Every other phase attempting
	// SYNC_STARTED is a no-op per the reducer's totality — re-asserted here as
	// the lock-contention property this task specifically names: the
	// orchestrator cannot even ATTEMPT a second concurrent slot-sync launch
	// because there is exactly one phase (`syncing`) representing "a sync is
	// running", and phase is a single field.
	test("SYNC_STARTED is only meaningful from sync-eligible; every other phase ignores it (reducer-level mutual exclusion)", async () => {
		const { reduceOrchestrator } = await import(
			"../modules/system/update-orchestrator/reducer.ts"
		);
		const { ORCHESTRATOR_PHASES, initialOrchestratorState } = await import(
			"../modules/system/update-orchestrator/types.ts"
		);
		for (const phase of ORCHESTRATOR_PHASES) {
			if (phase === "sync-eligible") continue;
			const state = { ...initialOrchestratorState(0), phase };
			const next = reduceOrchestrator(state, { type: "SYNC_STARTED", now: 1 });
			expect(next.phase).toBe(phase); // unchanged — no second sync can start
		}
	});
});
