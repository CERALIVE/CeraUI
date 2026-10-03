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

import { osChannelManifestSchema } from "../../modules/system/update-orchestrator/os-manifest.ts";
import {
	osStageCandidateKey,
	osStageNoticeId,
} from "../../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	type OrchestratorRuntimeDeps,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../../modules/ui/notifications.ts";
import { fakeDeps, testQuarantine } from "./orchestrator-runtime-harness.ts";

export const MIN = 60_000;

export const T0 = 10_000_000;

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

export const noticeId = osStageNoticeId(osStageCandidateKey(manifest));

export function osNotices(): string[] {
	return getPersistentNotifications(true)
		.show.map((notice) => notice.name)
		.filter((name) => name.startsWith("update:os-stage-"));
}

export function harness(
	outcomes: Array<Error | "ok">,
	overrides: Partial<OrchestratorRuntimeDeps> = {},
) {
	const clock = { now: T0 };
	const calls = { stages: 0, checks: 0, installs: 0 };
	const persisted: OrchestratorState[] = [];
	const attemptIds: string[] = [];
	const quarantine = testQuarantine();
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			now: () => clock.now,
			loadSettings: async () => ({
				packagesAuto: true,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: true,
			}),
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			quarantine,
			checkOsManifest: async () => {
				calls.checks++;
				return {
					available: true,
					rateLimited: false,
					failed: false,
					reason: "",
					manifest,
				};
			},
			newOsAttemptId: () =>
				`00000000-0000-4000-8000-${String(calls.stages + 1).padStart(12, "0")}`,
			stageOs: async (_manifest, _progress, control) => {
				calls.stages++;
				if (control) attemptIds.push(control.attemptId);
				const outcome = outcomes.shift() ?? "ok";
				if (outcome !== "ok") throw outcome;
			},
			startPackageInstall: () => {
				calls.installs++;
				return { started: true };
			},
			persist: (state) => persisted.push(state),
			...overrides,
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
		packageCheck: {
			...initialOrchestratorState(0).packageCheck,
			nextAttemptAt: T0 + 24 * 60 * MIN,
		},
	});
	return { clock, calls, persisted, attemptIds, quarantine };
}
