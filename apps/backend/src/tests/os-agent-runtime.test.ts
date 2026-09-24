import { afterEach, describe, expect, test } from "bun:test";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkUpdatesNow,
	type defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

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
const settings = {
	packagesAuto: false,
	systemAuto: true,
	schedule: { mode: "any-idle" as const, start: "03:00", end: "05:00" },
	channel: "stable" as const,
	allowPackagesOverCellular: true,
	allowSystemOverCellular: true,
};
const receipt = {
	schema: 1 as const,
	version: "2026.10.0",
	channel: "stable" as const,
	stagedAt: 1000,
	bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
afterEach(() => resetOrchestratorRuntimeForTest());

function setup(overrides: Partial<typeof defaultOrchestratorRuntimeDeps> = {}) {
	let stages = 0;
	setOrchestratorRuntimeDepsForTest({
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
		armOs: async () => {},
		readOsReceipt: async () => receipt,
		readBootId: async () => receipt.bootId,
		readBootedVersion: async () => "2026.9.0",
		persist: () => {},
		...overrides,
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
	});
	return { stages: () => stages };
}

describe("OS install dispatch", () => {
	test("does not call RAUC when stream is live", async () => {
		const { stages } = setup({ isStreamLive: () => true });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "stream_active",
		});
		expect(stages()).toBe(0);
		expect(getOrchestratorState().phase).toBe("os-available");
	});
	test("legacy image refuses without calling RAUC", async () => {
		const { stages } = setup({
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		});
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(stages()).toBe(0);
	});
	test("missing release stamp propagates typed booted_version_unknown refusal", async () => {
		setup({
			runPackageCheck: async () => null,
			getAvailablePackageCount: () => 0,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			checkOsManifest: async () => ({
				available: false,
				failed: true,
				rateLimited: false,
				reason: "booted_version_unknown",
			}),
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		expect(getOrchestratorState().failureReason).toBe("booted_version_unknown");
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "booted_version_unknown",
		});
	});
	test("metered OS download waits for the exact one-time approval", async () => {
		const { stages } = setup({ onlyMeteredCandidateExists: async () => true });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(stages()).toBe(0);
	});
	test("manual install bypasses idle, stages once and arms without immediate activation", async () => {
		const calls: boolean[] = [];
		const { stages } = setup({
			isIdle: async () => false,
			armOs: async (now) => {
				calls.push(now);
			},
		});
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(stages()).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-staged");
		await runOrchestratorTick();
		expect(calls).toEqual([false]);
		expect(getOrchestratorState().phase).toBe("os-activation-armed");
	});
	test("a stage failure never becomes staged or armed", async () => {
		const calls: boolean[] = [];
		setup({
			stageOs: async () => {
				throw new Error("rauc failed");
			},
			armOs: async (now) => {
				calls.push(now);
			},
		});
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(getOrchestratorState().phase).toBe("failed");
		expect(calls).toEqual([]);
	});
	test("seven-day pending slot activates with --now only while no stream is live", async () => {
		const calls: boolean[] = [];
		setup({
			now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
			armOs: async (now) => {
				calls.push(now);
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(calls).toEqual([true]);
		resetOrchestratorRuntimeForTest();
		setup({
			now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
			isStreamLive: () => true,
			armOs: async (now) => {
				calls.push(now);
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(calls).toEqual([true]);
	});
	test("post-reboot mismatch quarantines the expected staged version", async () => {
		const recorded: string[] = [];
		class RecordingQuarantine extends UpdateQuarantine {
			override async recordOsRollback(expected: string): Promise<void> {
				recorded.push(expected);
			}
		}
		setup({
			readBootId: async () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			readBootedVersion: async () => "2026.9.0",
			quarantine: new RecordingQuarantine(),
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(recorded).toEqual(["2026.10.0"]);
		expect(getOrchestratorState().phase).toBe("quarantined");
	});
	test("a restarted backend never reissues an inconclusive RAUC install", async () => {
		const { stages } = setup({ inspectOsOperation: async () => "idle" });
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-staging",
		});
		await runOrchestratorTick();
		expect(stages()).toBe(0);
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"os_stage_outcome_unknown_after_restart",
		);
	});
});
