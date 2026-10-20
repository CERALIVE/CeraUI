import { osChannelManifestSchema } from "../../modules/system/update-orchestrator/os-manifest.ts";
import {
	type defaultOrchestratorRuntimeDeps,
	type getOrchestratorState,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import { withMemoryPersistence } from "./orchestrator-memory-persistence.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const candidate = osChannelManifestSchema.parse({
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

export const settings = {
	packagesAuto: false,
	systemAuto: true,
	schedule: { mode: "any-idle" as const, start: "03:00", end: "05:00" },
	channel: "stable" as const,
	allowPackagesOverCellular: true,
	allowSystemOverCellular: true,
};

export const receipt = {
	schema: 1 as const,
	version: "2026.10.0",
	channel: "stable" as const,
	stagedAt: 1000,
	bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

export function setup(
	overrides: Partial<typeof defaultOrchestratorRuntimeDeps> = {},
	initial: ReturnType<typeof getOrchestratorState> | null = null,
) {
	let stages = 0;
	setOrchestratorRuntimeDepsForTest(
		withMemoryPersistence(
			{
				acquireOsStageControl: acquireTestOsStageControl,
				now: () => 2_000,
				loadSettings: async () => settings,
				loadCapabilities: async () => ({
					mode: "capable",
					features: ["apt-all-packages", "rauc-verity-streaming"],
				}),
				isIdle: async () => true,
				isStreamLive: () => false,
				onlyMeteredCandidateExists: async () => false,
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
				armOs: async () => {
					// Activation I/O is supplied only by cases that exercise it.
				},
				readOsReceipt: async () => receipt,
				readBootId: async () => receipt.bootId,
				readBootedVersion: async () => "2026.9.0",
				persist: () => {
					// withMemoryPersistence owns authoritative fixture storage.
				},
				...overrides,
			},
			initial,
		),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
	});
	return { stages: () => stages };
}
