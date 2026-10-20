import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	ensureOsUpdateAdmissionReady,
	osInstallClientsGone,
	osUpdateAdmissionReady,
	reconcileOsStageStartup,
} from "../modules/system/update-orchestrator/os-stage-startup.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanupRecovery,
	deferred,
	RETRY_DELAY,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";
import { harness, record } from "./helpers/os-stage-startup-harness.ts";

afterEach(cleanupRecovery);

test("client absence is positive proc evidence, not backend death or unreadability", async () => {
	// Given the old exact install client remains in proc despite observer death.
	const deps = {
		list: async () => ["123", "456"],
		read: async (path: string) =>
			path.includes("123")
				? `rauc\0install\0${record.bundleUrl}\0`
				: "unrelated\0",
	};
	// When scanning actual argv-shaped records.
	expect(await osInstallClientsGone(record.bundleUrl, deps)).toBe(false);
	expect(
		await osInstallClientsGone(record.bundleUrl, {
			...deps,
			read: async () => "unrelated\0",
		}),
	).toBe(true);
	// Then an unreadable proc file still withholds absence.
	expect(
		await osInstallClientsGone(record.bundleUrl, {
			...deps,
			read: async () => {
				throw new Error("unreadable");
			},
		}),
	).toBe(false);
});

test("main queues reconciliation only after the control server's readiness barrier", async () => {
	// Given the actual top-level-await entry cannot be imported without boot effects.
	const source = await Bun.file(new URL("../main.ts", import.meta.url)).text();
	// When checking the shipped call site's order and non-awaiting contract.
	const call = source.lastIndexOf("reconcileOsStageStartup()");
	// Then control readiness precedes asynchronous reconciliation and the old eager sweep is gone.
	expect(call).toBeGreaterThan(
		source.indexOf('await runCritical("systemd-ready"'),
	);
	expect(
		source.slice(
			source.lastIndexOf('guardNonCritical("update-route-sweep"') - 5,
			call,
		),
	).toContain("void guardNonCritical");
	expect(source).not.toContain("updatePinController.sweep()");
});

test("a later unsettled job closes admission and queues one recovery without blocking callers", async () => {
	const h = harness();
	expect(ensureOsUpdateAdmissionReady(true, h.deps)).toBe(false);
	expect(ensureOsUpdateAdmissionReady(true, h.deps)).toBe(false);
	await reconcileOsStageStartup(h.deps);
	expect(h.calls.filter((call) => call === "restart-submission")).toHaveLength(
		1,
	);
	expect(osUpdateAdmissionReady()).toBe(true);
});

test("queued reconciliation rechecks exact producer identity after the ownership await", async () => {
	const h = harness();
	const held = Promise.withResolvers<boolean>();
	const inspecting = Promise.withResolvers<void>();
	let live: string | null = null;
	const recovery = reconcileOsStageStartup({
		...h.deps,
		liveProducer: () => live,
		owner: (value) => ({
			...h.deps.owner(value),
			held: async () => {
				inspecting.resolve();
				return held.promise;
			},
		}),
	});
	await inspecting.promise;
	live = record.attemptId;
	held.resolve(true);
	expect(await recovery).toEqual({ kind: "none" });
	expect(h.calls).toEqual([]);
});

test.each(["manual check", "automatic retry"] as const)(
	"CR scheduling cannot bypass B's retained-writer admission for %s",
	async (action) => {
		// Given a due retry and a real startup reconciler retaining uncertain resources.
		const runtime = await recoveryHarness({
			stageOs: async () => {
				throw new OsStageError("os_transport_failed");
			},
		});
		await runOrchestratorTick();
		runtime.clock.now += RETRY_DELAY;
		const before = getOrchestratorState();
		const h = harness();
		const probeStarted = deferred<void>();
		const release = deferred<void>();
		const startupDeps = {
			...h.deps,
			observe: async () => {
				probeStarted.resolve();
				await release.promise;
				return { ...record.baseline, resources: ["mount:51"] };
			},
		};
		const reconciliation = reconcileOsStageStartup(startupDeps);
		await probeStarted.promise;
		setOrchestratorRuntimeDepsForTest({
			isUpdateAdmissionReady: async () =>
				ensureOsUpdateAdmissionReady(true, startupDeps),
		});
		// When the operator or due automatic clock asks for work.
		try {
			if (action === "manual check")
				expect(await checkUpdatesNow()).toEqual({
					started: false,
					reason: "busy",
				});
			else await runOrchestratorTick();
			// Then no discovery or stage permission is consumed while ownership is uncertain.
			expect(getOrchestratorState()).toBe(before);
			expect(runtime.calls).toEqual({ stages: 1, checks: 1 });
		} finally {
			release.resolve();
			await expect(reconciliation).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
		}
		expect(h.calls).not.toContain("release");
	},
);
