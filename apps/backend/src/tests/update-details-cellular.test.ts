/**
 * Todo 41 — the Updates dialog's backend reads.
 *
 *   1. `summarizeTransportSelection` projects a ranked selection onto the wire
 *      summary without inventing a verdict (captive is derived from the probe
 *      states, never assumed).
 *   2. `readUpdateDetails` degrades each block to `null` independently and never
 *      claims a slot mirror on a legacy image or a "staged" image after the
 *      orchestrator has left the staged phases.
 *   3. The runtime's pending cellular approval exists ONLY while the D12 gate is
 *      actually holding that candidate, and every real state transition pushes
 *      the `update_orchestrator` wire projection.
 */
/**
 * Todo 41 — the Updates dialog's backend reads.
 *
 *   1. `summarizeTransportSelection` projects a ranked selection onto the wire
 *      summary without inventing a verdict (captive is derived from the probe
 *      states, never assumed).
 *   2. `readUpdateDetails` degrades each block to `null` independently and never
 *      claims a slot mirror on a legacy image or a "staged" image after the
 *      orchestrator has left the staged phases.
 *   3. The runtime's pending cellular approval exists ONLY while the D12 gate is
 *      actually holding that candidate, and every real state transition pushes
 *      the `update_orchestrator` wire projection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { UpdateOrchestratorWireState } from "@ceraui/rpc/schemas";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	allowCellularOnce,
	type defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	getOsUpdateSummary,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { resetLastTransportSelectionForTest } from "../modules/system/update-transport/last-selection.ts";
import { withMemoryPersistence } from "./helpers/orchestrator-memory-persistence.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	resetLastTransportSelectionForTest();
});

const candidate = osChannelManifestSchema.parse({
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
		size: 734_003_200,
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

function osRuntime(
	overrides: Partial<typeof defaultOrchestratorRuntimeDeps> = {},
): { published: UpdateOrchestratorWireState[]; stages: () => number } {
	const published: UpdateOrchestratorWireState[] = [];
	let stages = 0;
	setOrchestratorRuntimeDepsForTest(
		withMemoryPersistence({
			acquireOsStageControl: acquireTestOsStageControl,
			now: () => 2_000,
			loadSettings: async () => ({
				packagesAuto: false,
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
			isIdle: async () => true,
			isStreamLive: () => false,
			onlyMeteredCandidateExists: async () => true,
			checkOsManifest: async () => ({
				available: true,
				failed: false,
				rateLimited: false,
				reason: "",
				manifest: candidate,
			}),
			stageOs: async () => {
				stages += 1;
			},
			armOs: async () => {},
			persist: () => {},
			publishWireState: (wire) => published.push(wire),
			...overrides,
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
	});
	return { published, stages: () => stages };
}

describe("pending cellular approval + wire push", () => {
	test("a metered-only hold names the candidate and its size; approval releases it", async () => {
		const { published, stages } = osRuntime();
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(getOsUpdateSummary()).toEqual({
			candidate: { version: "2026.10.0", sizeBytes: 734_003_200 },
			pendingCellular: { id: "2026.10.0", sizeBytes: 734_003_200 },
		});
		expect(stages()).toBe(0);

		allowCellularOnce("2026.10.0");
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(stages()).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-staged");
		expect(getOsUpdateSummary().pendingCellular).toBeNull();
		// Every transition was pushed; the last one is the staged phase.
		expect(published.map((wire) => wire.phase)).toContain("os-staging");
		expect(published.at(-1)?.phase).toBe("os-staged");
	});

	test("an unmetered uplink never asks for approval", async () => {
		osRuntime({ onlyMeteredCandidateExists: async () => false });
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(getOsUpdateSummary().pendingCellular).toBeNull();
	});

	test("a throwing publisher never blocks the transition it describes", async () => {
		const { stages } = osRuntime({
			onlyMeteredCandidateExists: async () => false,
			publishWireState: () => {
				throw new Error("socket gone");
			},
		});
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(stages()).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-staged");
	});
});
