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
import {
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
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
	test("refuses with a typed reason when no update is available (not in the available phase)", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "not_available" });
	});

	test("refuses busy when already mid-pipeline", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "busy" });
	});

	test("MUST NOT DO: refuses stream_active when a stream is live, even though it otherwise bypasses idle — and the phase never leaves 'available'", async () => {
		let installUnitStarted = false;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isStreamLive: () => true,
				isIdle: async () => true, // idle would say "go", but the stream check must win
				startPackageInstall: () => {
					installUnitStarted = true;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "stream_active" });
		// The phase must NOT have moved into awaiting-idle/downloading/committing —
		// an operator action must never queue a Go Live request behind an update,
		// and must never queue an update behind a stream either.
		expect(getOrchestratorState().phase).toBe("available");
		expect(installUnitStarted).toBe(false);
	});

	test("bypasses idle when no stream is live: available -> awaiting-idle -> downloading, without ever consulting isIdle()", async () => {
		let idleChecked = false;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isStreamLive: () => false,
				isIdle: async () => {
					idleChecked = true;
					return false; // would refuse a scheduled attempt; must not matter here
				},
				startPackageInstall: () => ({ started: true }),
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: true });
		expect(idleChecked).toBe(false);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	test("reports stream_active when the stream starts during pending-plan persistence", async () => {
		let releasePending: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			releasePending = resolve;
		});
		let savingPending: (() => void) | undefined;
		const saving = new Promise<void>((resolve) => {
			savingPending = resolve;
		});
		let streamLive = false;
		let launches = 0;
		const quarantine = testQuarantine();
		const savePending = quarantine.savePending.bind(quarantine);
		quarantine.savePending = async (packages) => {
			savingPending?.();
			await pending;
			await savePending(packages);
		};
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine,
				isStreamLive: () => streamLive,
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					launches++;
					return streamLive
						? { started: false, reason: "streaming" }
						: { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});

		const attempt = installUpdatesNow();
		await saving;
		streamLive = true;
		releasePending?.();

		expect(await attempt).toEqual({ started: false, reason: "stream_active" });
		expect(launches).toBe(1);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(await quarantine.readPending()).toEqual([]);
	});

	test.each([
		["already_updating", "busy"],
		["check_unavailable", "not_available"],
		["updates_disabled", "busy"],
	] as const)("maps launch refusal %s to %s", async (refusal, reason) => {
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				startPackageInstall: () => ({ started: false, reason: refusal }),
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});

		expect(await installUpdatesNow()).toEqual({ started: false, reason });
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
	});

	test("refuses a live stream from awaiting-idle without launching or changing the pending phase", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isStreamLive: () => true,
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
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "stream_active",
		});
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(installs).toBe(0);
	});

	test("refuses manual install while committing or restarting services", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		for (const phase of ["committing", "restarting-services"] as const) {
			setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
			expect(await installUpdatesNow()).toEqual({
				started: false,
				reason: "busy",
			});
			expect(getOrchestratorState().phase).toBe(phase);
		}
		expect(installs).toBe(0);
	});
});
