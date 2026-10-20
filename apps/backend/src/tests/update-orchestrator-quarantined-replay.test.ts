import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { checkOsChannel } from "../modules/system/update-orchestrator/os-agent.ts";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkOsManifestResult,
	checkUpdatesNow,
	getOrchestratorState,
	getOsUpdateSummary,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { resetDismissalStoreForTests } from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import {
	bytes,
	context,
	deps,
	manifest,
	signature,
} from "./helpers/os-manifest-fixture.ts";

const replayNotice = "update:refused:os-check:serial_replayed";
const originalDismissalsPath = process.env.CERALIVE_DISMISSALS_FILE;
let root: string | undefined;

function clearNotices() {
	for (const notice of getPersistentNotifications(true).show) {
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
	}
}

beforeEach(() => {
	resetOrchestratorRuntimeForTest();
	clearNotices();
	resetDismissalStoreForTests();
});
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	clearNotices();
	resetDismissalStoreForTests();
	if (originalDismissalsPath === undefined)
		delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = originalDismissalsPath;
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "quarantined-replay-"));
	root = dir;
	process.env.CERALIVE_DISMISSALS_FILE = join(dir, "dismissals.json");
	const path = join(dir, "quarantine.json");
	const quarantine = new UpdateQuarantine(path, async () => {});
	const signed = {
		data: bytes(manifest),
		signature,
		context: { ...context, serial: manifest.serial },
		verification: {
			...deps,
			compare: async (left: string, right: string) =>
				left.localeCompare(right, "en", { numeric: true }) > 0,
			isQuarantined: (version: string) =>
				quarantine.isOsVersionQuarantined(version),
		},
	};
	let stages = 0;
	let installs = 0;
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			isUpdateAdmissionReady: async () => true,
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			checkOsManifest: (channel) =>
				checkOsManifestResult(channel ?? "stable", (settingsChannel) =>
					checkOsChannel(settingsChannel, quarantine, async () => signed),
				),
			stageOs: async () => {
				stages++;
			},
			startPackageInstall: () => {
				installs++;
				return { started: true };
			},
		}),
	);
	setOrchestratorStateForTest(initialOrchestratorState(0));
	return {
		quarantine,
		path,
		signed,
		stages: () => stages,
		installs: () => installs,
	};
}

test.each([
	[false, 3],
	[true, 4],
] as const)(
	"quarantined replay stays refused without warning (standing notice: %s)",
	async (standing, serial) => {
		// Given an exact known-bad version and, optionally, the old warning.
		const f = await fixture();
		f.signed.context.serial = serial;
		await f.quarantine.recordOsRollback(
			manifest.version,
			context.bootedVersion,
		);
		if (standing)
			notifyUpdate({
				kind: "refused",
				id: "os-check:serial_replayed",
				reason: "serial_replayed",
			});
		notifyUpdate({
			kind: "refused",
			id: "os-check:expired",
			reason: "expired",
		});
		const warn = spyOn(logger, "warn");
		const debug = spyOn(logger, "debug");
		try {
			// When Check traverses trusted discovery and the runtime failure boundary twice.
			await checkUpdatesNow();
			await checkUpdatesNow();
			// Then only the replay notice is absent; the refusal/backoff and install veto remain.
			expect(
				getPersistentNotifications(true).show.map((n) => n.name),
			).not.toContain(replayNotice);
			expect(
				getPersistentNotifications(true).show.map((n) => n.name),
			).toContain("update:refused:os-check:expired");
			expect(warn.mock.calls).toHaveLength(0);
			expect(debug.mock.calls.length).toBeGreaterThan(0);
			expect(getOrchestratorState().failureReason).toBe("serial_replayed");
			expect(getOrchestratorState().osCheck.consecutiveFailures).toBe(2);
			expect(getOsUpdateSummary().candidate).toBeNull();
			expect(await installUpdatesNow()).toEqual({
				started: false,
				reason: "not_available",
			});
			expect(f.stages()).toBe(0);
			expect(f.installs()).toBe(0);
			expect(
				await validateSignedOsManifest(
					f.signed.data,
					signature,
					f.signed.context,
					f.signed.verification,
				),
			).toEqual({ ok: false, reason: "serial_replayed" });
		} finally {
			warn.mockRestore();
			debug.mockRestore();
		}
	},
);

test.each(["absent", "near-version", "package-only", "corrupt"] as const)(
	"replayed version with %s OS protection still warns",
	async (kind) => {
		// Given no exact OS quarantine match (package/name-prefix evidence cannot substitute).
		const f = await fixture();
		if (kind === "corrupt") await Bun.write(f.path, "{");
		if (kind === "near-version")
			await f.quarantine.recordOsRollback(
				`${manifest.version}0`,
				context.bootedVersion,
			);
		if (kind === "package-only")
			await f.quarantine.recordPackageFailure([
				{ name: "cerastream", version: manifest.version },
			]);
		// When an operator checks the replayed pointer.
		await checkUpdatesNow();
		// Then normal replay refusal and its warning are unchanged.
		expect(getPersistentNotifications(true).show).toContainEqual(
			expect.objectContaining({ name: replayNotice, type: "warning" }),
		);
		expect(getOrchestratorState().failureReason).toBe("serial_replayed");
		expect(getOrchestratorState().osCheck.consecutiveFailures).toBe(1);
		expect(getOsUpdateSummary().candidate).toBeNull();
		expect(f.stages()).toBe(0);
	},
);

test.each([
	"downgrade_or_same",
	"expired",
	"signature_invalid",
	"version_quarantined",
] as const)("quarantine does not silence %s", async (reason) => {
	// Given a known-bad version with a refusal other than serial replay.
	const f = await fixture();
	await f.quarantine.recordOsRollback(manifest.version, context.bootedVersion);
	f.signed.context.serial = manifest.serial - 1;
	if (reason === "downgrade_or_same")
		f.signed.context.bootedVersion = "2026.11.0";
	if (reason === "expired")
		f.signed.context.now = Date.parse("2027-01-01T00:00:00Z");
	if (reason === "signature_invalid")
		f.signed.verification.verifyCms = async () => {
			throw new Error("invalid CMS fixture");
		};
	// When trusted discovery or trust validation refuses the pointer.
	await checkUpdatesNow();
	// Then the existing reason-specific warning remains.
	expect(getOrchestratorState().failureReason).toBe(reason);
	expect(getPersistentNotifications(true).show.map((n) => n.name)).toContain(
		`update:refused:os-check:${reason}`,
	);
	expect(f.stages()).toBe(0);
});
