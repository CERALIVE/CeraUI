import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import {
	board,
	FALLBACK_BOOT,
	healthyFor,
	notices,
	V2,
} from "./helpers/os-verify-healthcheck-harness.ts";

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function fixture() {
	root = await mkdtemp(join(tmpdir(), "orchestrator-rollback-"));
	const path = join(root, "agent.json");
	setOrchestratorStateFilePathForTest(path);
	const quarantine = new UpdateQuarantine(
		join(root, "quarantine.json"),
		async () => {},
	);
	const b = board("2026.10.76", {
		bootedVersion: V2,
		bootId: FALLBACK_BOOT,
		healthy: healthyFor(FALLBACK_BOOT),
	});
	const deps = fakeDeps({
		...b.deps,
		persist: saveOrchestratorState,
		readPersistedState: loadOrchestratorState,
		quarantine,
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			channel: "stable",
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		isUpdateAdmissionReady: async () => true,
	});
	return { path, quarantine, deps };
}

test("rollback returns idle after recording protection and notification, so Check works", async () => {
	// Given a fallback boot with an activation receipt.
	const f = await fixture();
	setOrchestratorRuntimeDepsForTest(f.deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-verifying",
	});
	// When verification observes rollback.
	await runOrchestratorTick();
	// Then protection survives without blocking subsequent discovery.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: null,
	});
	expect(await f.quarantine.isOsVersionQuarantined("2026.10.76")).toBe(true);
	expect(notices("os-rollback", "2026.10.76")).toBe(1);
	expect(await checkUpdatesNow()).toEqual({ started: true });
});

test.each(["startup", "tick"] as const)(
	"recorded bench quarantine self-heals on %s",
	async (entry) => {
		// Given the exact historical phase and a matching recorded OS version.
		const f = await fixture();
		await f.quarantine.recordOsRollback("2026.10.76", V2);
		const old = {
			...initialOrchestratorState(0),
			phase: "quarantined" as const,
			failureReason: "os_version_mismatch",
		};
		saveOrchestratorState(old);
		setOrchestratorRuntimeDepsForTest(f.deps);
		setOrchestratorStateForTest(old);
		// When the startup or tick owner reads it.
		if (entry === "startup") await startUpdateOrchestrator(f.deps);
		else await runOrchestratorTick();
		// Then only workflow quarantine is cleared, including on disk.
		expect(getOrchestratorState()).toMatchObject({
			phase: "idle",
			failureReason: null,
		});
		expect(await Bun.file(f.path).json()).toMatchObject({
			phase: "idle",
			failureReason: null,
		});
		expect(await f.quarantine.isOsVersionQuarantined("2026.10.76")).toBe(true);
	},
);

test.each(["missing", "different-version", "package-only", "invalid"] as const)(
	"rollback quarantine stays closed with %s OS evidence",
	async (kind) => {
		// Given no matching OS protection; package evidence cannot substitute.
		const f = await fixture();
		if (kind === "different-version")
			await f.quarantine.recordOsRollback("2026.10.77", V2);
		if (kind === "package-only")
			await f.quarantine.recordPackageFailure([
				{ name: "cerastream", version: "2026.10.76" },
			]);
		if (kind === "invalid")
			await Bun.write(join(root ?? "", "quarantine.json"), "{");
		const old = {
			...initialOrchestratorState(0),
			phase: "quarantined" as const,
			failureReason: "os_version_mismatch",
		};
		saveOrchestratorState(old);
		const before = await Bun.file(f.path).text();
		setOrchestratorRuntimeDepsForTest(f.deps);
		setOrchestratorStateForTest(old);
		// When a scheduling tick attempts clearance.
		await runOrchestratorTick().catch((error: unknown) => {
			if (kind !== "invalid") throw error;
		});
		// Then no workflow or persisted byte changes.
		expect(getOrchestratorState()).toEqual(old);
		expect(await Bun.file(f.path).text()).toBe(before);
	},
);

test.each(["COMMIT_FAILED", "COMMIT_RESUME_UNRESOLVED"] as const)(
	"%s remains byte-identical through scheduling with OS history present",
	async (type) => {
		// Given a package terminal state alongside historical OS rollback protection.
		const f = await fixture();
		await f.quarantine.recordOsRollback("2026.10.76", V2);
		const old = reduceOrchestrator(
			{ ...initialOrchestratorState(0), phase: "committing" },
			{ type, now: 1, reason: "apt-exit-1" },
		);
		saveOrchestratorState(old);
		const before = await Bun.file(f.path).text();
		setOrchestratorRuntimeDepsForTest(f.deps);
		setOrchestratorStateForTest(old);
		// When scheduling runs.
		await runOrchestratorTick();
		// Then package terminal policy remains sticky.
		expect(getOrchestratorState()).toEqual(old);
		expect(await Bun.file(f.path).text()).toBe(before);
	},
);

test("the lagged mirror starts from recovered rollback idle", async () => {
	// Given matching OS protection and this boot's healthy mirror inputs.
	const f = await fixture();
	await f.quarantine.recordOsRollback("2026.10.76", V2);
	let mirrors = 0;
	const healthy = healthyFor(FALLBACK_BOOT);
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		readSlotSyncEvidence: async () => ({
			healthyState: healthy,
			bootId: FALLBACK_BOOT,
			statusSha256: healthy.dpkg_status_sha256,
			buildId: healthy.build_id,
			receiptStateSha256: null,
			receiptTarget: "not-other",
			receiptTargetSlot: null,
		}),
		startSlotSync: async () => {
			mirrors++;
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "quarantined",
		failureReason: "os_version_mismatch",
	});
	// When the scheduler clears only the recorded rollback.
	await runOrchestratorTick();
	// Then normal mirror admission can restore redundancy.
	expect(mirrors).toBe(1);
	expect(getOrchestratorState().phase).toBe("syncing");
});
