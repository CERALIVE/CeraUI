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
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("installUpdatesNow — bypasses idle, NEVER bypasses the stream-live check", () => {
	test("a refused scheduled launch remains pending for the next tick", async () => {
		let attempts = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				startPackageInstall: () => {
					attempts++;
					return attempts === 1
						? { started: false, reason: "already_updating" }
						: { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});

		await runOrchestratorTick();
		expect(attempts).toBe(1);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		await runOrchestratorTick();
		expect(attempts).toBe(2);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	test("starts a pending automatic install immediately when the operator asks during awaiting-idle", async () => {
		let installs = 0;
		let idleChecks = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				isIdle: async () => {
					idleChecks++;
					return false;
				},
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(installs).toBe(0);

		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(installs).toBe(1);
		expect(idleChecks).toBe(1);
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "busy",
		});
		expect(installs).toBe(1);
	});

	test("manual awaiting-idle install persists commit success and releases the launch guard", async () => {
		let installs = 0;
		let wire: UpdateState = {
			kind: "available",
			identity: { version: "app-update", packages: ["cerastream"] },
			package_count: 1,
			actionable_count: 1,
			packages: [{ name: "cerastream", layer: "app", actionable: true }],
		};
		const persisted: string[] = [];
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				isIdle: async () => false,
				getPackageInstallWireState: () => wire,
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
				persist: (next) => persisted.push(next.phase),
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});

		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(installs).toBe(1);
		wire = { kind: "success" } as UpdateState;
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("restarting-services");
		expect(persisted).toEqual([
			"downloading",
			"committing",
			"restarting-services",
		]);

		wire = {
			kind: "available",
			identity: { version: "next-update", packages: ["cerastream"] },
			package_count: 1,
			actionable_count: 1,
			packages: [{ name: "cerastream", layer: "app", actionable: true }],
		};
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(installs).toBe(2);
	});

	test("two simultaneous manual requests for the same pending install launch only one unit", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		const first = installUpdatesNow();
		const second = installUpdatesNow();
		expect(await Promise.all([first, second])).toEqual([
			{ started: true },
			{ started: false, reason: "busy" },
		]);
		expect(installs).toBe(1);
	});
});
