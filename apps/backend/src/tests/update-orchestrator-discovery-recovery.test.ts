import { afterEach, describe, expect, test } from "bun:test";
import {
	clearOsStageNotices,
	notifyUpdate,
} from "../modules/system/update-orchestrator/notifications.ts";
import { checkOsChannel } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	type ManifestContext,
	osChannelManifestSchema,
} from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	osStageCandidateKey,
	osStageNoticeId,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkOsManifestResult,
	checkUpdatesNow,
	getOrchestratorState,
	getOsUpdateSummary,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const manifest = osChannelManifestSchema.parse({
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
const T0 = Date.parse("2026-10-01T12:00:00Z");
const RETRY_AT = T0 + 15 * 60_000;
const candidateKey = osStageCandidateKey(manifest);
const noticeId = osStageNoticeId(candidateKey);
const checkIds = [
	"os-check:downgrade_or_same",
	"os-check:serial_replayed",
] as const;

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
});

function harness() {
	// Mutable device observations let the next signed read disagree with the cached offer.
	const observed = {
		now: T0,
		quarantined: false,
		stages: 0,
		reads: 0,
		context: {
			board: manifest.board,
			compatible: manifest.compatible,
			channel: manifest.channel,
			serial: 2,
			bootedVersion: "2026.9.0",
			installedVersion: "2026.9.3",
			now: T0,
		} satisfies ManifestContext,
	};
	const read = async () => {
		observed.reads++;
		return {
			data: new TextEncoder().encode(JSON.stringify(manifest)),
			signature: new Uint8Array([1]),
			context: { ...observed.context, now: observed.now },
			verification: {
				verifyCms: async () => ({
					cn: "CeraLive OTA Manifest Signer",
					eku: ["codeSigning"],
					issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
				}),
				compare: async (left: string, right: string) =>
					(
						await runTestCommand([
							"dpkg",
							"--compare-versions",
							left,
							"gt",
							right,
						])
					).code === 0,
				isQuarantined: async () => observed.quarantined,
			},
		};
	};
	setOrchestratorRuntimeDepsForTest({
		now: () => observed.now,
		random: () => 0.5,
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
		onlyMeteredCandidateExists: async () => false,
		runPackageCheck: async () => null,
		getPackageInstallWireState: () => ({ kind: "idle" }),
		checkOsManifest: (channel) =>
			checkOsManifestResult(
				channel ?? "stable",
				(settingsChannel, quarantine) =>
					checkOsChannel(settingsChannel, quarantine, read),
			),
		stageOs: async () => {
			observed.stages++;
		},
		persist: () => {},
	});
	setOrchestratorStateForTest(initialOrchestratorState(0));
	return { observed, read };
}

function seedRetry(): void {
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		osStageRecovery: {
			candidateKey,
			activeAttemptId: null,
			failedRounds: 2,
			nextRetryAt: RETRY_AT,
			mode: "automatic",
			reason: "os_transport_failed",
		},
	});
	notifyUpdate({
		kind: "os-stage-retry",
		id: noticeId,
		version: manifest.version,
	});
}

describe("signed discovery across OS staging recovery", () => {
	test.each(["2026.10.0", "2026.11.0"])(
		"drops an obsolete retry without staging when the booted version is %s",
		async (bootedVersion) => {
			// Given a cached strictly admitted offer and a settled retry now superseded by boot truth.
			const { observed } = harness();
			await checkUpdatesNow();
			seedRetry();
			observed.context.bootedVersion = bootedVersion;
			observed.context.serial = 3;
			observed.now = RETRY_AT;
			// Without this interaction, success-none could leave a stale budget/notice or restage a consumed pointer.
			// When the due retry re-reads the real discovery path.
			await runOrchestratorTick();
			// Then both current and installed-serial retire only the obsolete staging recovery.
			expect(getOrchestratorState().phase).toBe("idle");
			expect(getOrchestratorState().osStageRecovery).toBeUndefined();
			expect(getOrchestratorState().osCheck.nextAttemptAt).toBe(
				RETRY_AT + 12 * 60 * 60_000,
			);
			expect(getOsUpdateSummary().candidate).toBeNull();
			expect(observed.stages).toBe(0);
			expect(
				getPersistentNotifications(true).show.map((n) => n.name),
			).not.toContain(`update:os-stage-retry:${noticeId}`);
		},
	);

	test.each(["version_quarantined", "ceraui_too_old"] as const)(
		"retains the retry budget without staging when fresh admission refuses %s",
		async (reason) => {
			// Given an admitted cached candidate that no longer meets installation constraints.
			const { observed } = harness();
			await checkUpdatesNow();
			seedRetry();
			const recovery = getOrchestratorState().osStageRecovery;
			observed.quarantined = reason === "version_quarantined";
			observed.context.installedVersion =
				reason === "ceraui_too_old" ? "2026.9.0" : "2026.9.3";
			observed.now = RETRY_AT;
			// Without this interaction, a permissive discovery result could bypass C's re-admission gate.
			// When automatic recovery reaches its deadline.
			await runOrchestratorTick();
			// Then the real strict refusal survives and consumes no attempt or retry budget.
			expect(getOrchestratorState().failureReason).toBe(reason);
			expect(getOrchestratorState().osStageRecovery).toEqual(recovery);
			expect(observed.reads).toBe(2);
			expect(observed.stages).toBe(0);
		},
	);

	test("preserves stage recovery notices when trusted-current clears check refusals", async () => {
		// Given both namespaces standing together for the same version.
		const { observed, read } = harness();
		observed.context.bootedVersion = manifest.version;
		seedRetry();
		for (const id of checkIds)
			notifyUpdate({ kind: "refused", id, reason: id });
		// Without this interaction, check-notice cleanup could silently erase an unresolved stage notice.
		// When A clears obsolete check refusals directly (no runtime supersession).
		await checkOsChannel("stable", new UpdateQuarantine(), read);
		// Then C's candidate notice survives.
		expect(getPersistentNotifications(true).show.map((n) => n.name)).toEqual([
			`update:os-stage-retry:${noticeId}`,
		]);
	});

	test("preserves check refusals when staging recovery notices clear", () => {
		// Given both namespaces standing together.
		harness();
		seedRetry();
		for (const id of checkIds)
			notifyUpdate({ kind: "refused", id, reason: id });
		// Without this interaction, stage cleanup could erase A's standing anti-replay refusal.
		// When C clears one candidate's recovery notice.
		clearOsStageNotices(noticeId);
		// Then A's check refusals remain independently addressable.
		expect(getPersistentNotifications(true).show.map((n) => n.name)).toEqual(
			checkIds.map((id) => `update:refused:${id}`),
		);
	});
});
