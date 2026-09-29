import { afterEach, describe, expect, test } from "bun:test";
import { fetchAsOta } from "../modules/system/update-orchestrator/os-agent.ts";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkOsManifestResult,
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
import { selectUpdateTransport } from "../modules/system/update-transport/executor.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";

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

describe("OS channel publication over a healthy transport", () => {
	async function checkFromHttp(status: number, signatureStatus = status) {
		const urls: string[] = [];
		const check = async () => {
			const base =
				"https://images.ceralive.tv/channels/stable/rock-5b-plus.json";
			const selection = await selectUpdateTransport(
				{ profile: "os", board: "rock-5b-plus", channel: "stable" },
				{
					listIfnames: () => ["eth0"],
					readSources: async () => "",
					credentials: async () => undefined,
					mmIfnames: () => [],
					routerIfnames: () => [],
					dongleIfnames: () => [],
					run: async (argv) => {
						if (argv[0] === "nmcli")
							return {
								exitCode: 0,
								stdout:
									"GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no (guessed)",
								stderr: "",
							};
						if (argv[0] === "resolvectl")
							return argv.includes("-6")
								? { exitCode: 1, stdout: "", stderr: "no IPv6 route" }
								: {
										exitCode: 0,
										stdout: `${argv.at(-1)}: 192.0.2.1`,
										stderr: "",
									};
						const code = argv.at(-1)?.endsWith("/generate_204")
							? 204
							: signatureStatus === 404 || signatureStatus === 410
								? signatureStatus
								: status === 404 || status === 410
									? status
									: 200;
						return {
							exitCode: 0,
							stdout: `\n<<<update-probe>>>${code} 0.01`,
							stderr: "",
						};
					},
				},
			);
			if (selection.status !== "selected")
				throw new Error("OS channel has no healthy uplink");
			const fetchDeps = {
				readUid: async () => "987",
				run: async (argv: string[]) => {
					const url = argv.at(-1) ?? "";
					urls.push(url);
					const code = url.endsWith(".sig") ? signatureStatus : status;
					return {
						exitCode: code === 200 ? 0 : 22,
						stdout: String(code),
						stderr: code === 200 ? "" : `curl: (22) HTTP ${code}`,
					};
				},
			};
			if (!(await fetchAsOta(base, "/tmp/manifest.json", 987, fetchDeps)))
				return undefined;
			if (
				!(await fetchAsOta(`${base}.sig`, "/tmp/manifest.sig", 987, fetchDeps))
			)
				return undefined;
			return candidate;
		};
		setup({
			runPackageCheck: async () => null,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			checkOsManifest: (channel) =>
				checkOsManifestResult(channel ?? "stable", check),
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const outcome = await checkUpdatesNow();
		return { outcome, state: getOrchestratorState(), urls };
	}

	test.each([404, 410])(
		"an unpublished channel object (%i) completes the OS check with nothing available",
		async (status) => {
			const refusedBefore = getPersistentNotifications(true).show.filter(
				(item) => item.name.startsWith("update:refused:os-check:"),
			).length;
			const { outcome, state, urls } = await checkFromHttp(status);
			expect(outcome).toEqual({ started: true });
			expect(state.phase).toBe("idle");
			expect(state.failureReason).toBeNull();
			expect(state.osCheck.consecutiveFailures).toBe(0);
			expect(state.osCheck.lastSuccessAt).not.toBeNull();
			expect(urls).toEqual([
				"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			]);
			await checkUpdatesNow();
			expect(getOrchestratorState().failureReason).toBeNull();
			expect(
				getPersistentNotifications(true).show.filter((item) =>
					item.name.startsWith("update:refused:os-check:"),
				).length,
			).toBe(refusedBefore);
		},
	);

	test("a missing signature beside a published JSON is also not available", async () => {
		const { state, urls } = await checkFromHttp(200, 404);
		expect(state.phase).toBe("idle");
		expect(state.failureReason).toBeNull();
		expect(state.osCheck.consecutiveFailures).toBe(0);
		expect(state.osCheck.lastSuccessAt).not.toBeNull();
		expect(urls).toEqual([
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig",
		]);
	});

	test("a published channel still offers the verified candidate", async () => {
		const { state, urls } = await checkFromHttp(200);
		expect(state.phase).toBe("os-available");
		expect(state.osCheck.lastSuccessAt).not.toBeNull();
		expect(urls).toEqual([
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig",
		]);
	});

	test("a 503 object response is an OS check failure, not a missing publication", async () => {
		const { state } = await checkFromHttp(503);
		expect(state.phase).toBe("idle");
		expect(state.failureReason).not.toBeNull();
		expect(state.osCheck.consecutiveFailures).toBe(1);
	});

	test("curl TLS verification failure cannot be mistaken for an unpublished channel", async () => {
		const outcome = await fetchAsOta(
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			"/tmp/manifest.json",
			987,
			{
				readUid: async () => "987",
				run: async () => ({ exitCode: 60, stdout: "404", stderr: "TLS" }),
			},
		).then(
			() => "resolved",
			(error: unknown) => error,
		);
		expect(outcome).toMatchObject({ reason: "manifest_fetch_failed" });
	});
});
