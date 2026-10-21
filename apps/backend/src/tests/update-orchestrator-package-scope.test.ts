import { afterEach, expect, test } from "bun:test";
import { ORCHESTRATOR_PHASES } from "@ceraui/rpc/schemas";
import {
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { setup as osFixture } from "./helpers/os-agent-runtime-harness.ts";
import {
	cleanScopedFixture,
	movePhase,
	offeredPackages,
	scopedFixture,
} from "./helpers/package-scoped-install.ts";

afterEach(cleanScopedFixture);

test("scoped simultaneous OS and package offers never enter OS staging", async () => {
	// Given the existing real OS-dispatch fixture with a simultaneous package inventory.
	const f = osFixture({ getPackageInstallWireState: () => offeredPackages });
	const before = getOrchestratorState();
	// When a stale client requests packages in the OS-owned phase.
	expect(await installUpdatesNow({ scope: "packages" })).toEqual({
		started: false,
		reason: "not_available",
	});
	// Then the same fixture which stages on unscoped Install now remains untouched.
	expect(f.stages()).toBe(0);
	expect(getOrchestratorState()).toEqual(before);
});

test("scoped completion retains the existing installed notice and pending-plan cleanup", async () => {
	// Given the real tracked package lifecycle and its actionable plan.
	let wire = offeredPackages;
	const f = scopedFixture({
		getPackageInstallWireState: () => wire,
		restartStale: async () => true,
	});
	await installUpdatesNow({ scope: "packages" });
	// When the normal tick observes package success and finishes service handling.
	wire = {
		kind: "success",
	};
	await runOrchestratorTick();
	await runOrchestratorTick();
	// Then the production installed notice names the plan's package and retires it.
	const notices = getPersistentNotifications(true).show.filter((notice) =>
		notice.name.startsWith("update:installed:"),
	);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.params).toMatchObject({ packages: "cerastream" });
	expect(getOrchestratorState().phase).toBe("settled");
	expect(await f.quarantine.readPending()).toEqual([]);
	for (const notice of notices) notificationRemove(notice.name);
});

test.each(["available", "awaiting-idle"] as const)(
	"scoped %s installs only actionable packages through the tracked path",
	async (phase) => {
		// Given both OS capability and a package offer, without idle permission.
		const f = scopedFixture();
		movePhase(phase);
		// When the package-labelled action is requested.
		const outcome = await installUpdatesNow({ scope: "packages" });
		// Then the existing tracked install and exact pending plan own completion.
		expect(outcome).toEqual({ started: true });
		expect(f.launches()).toBe(1);
		expect(f.stages()).toBe(0);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await f.quarantine.readPending()).toEqual([
			{ name: "cerastream", version: "2026.10.1" },
		]);
	},
);

test.each(
	ORCHESTRATOR_PHASES.filter(
		(phase) => phase !== "available" && phase !== "awaiting-idle",
	),
)(
	"scoped %s refuses without changing state or launching an OS stage",
	async (phase) => {
		// Given a non-package owner, even with a simultaneous package inventory.
		const f = scopedFixture();
		movePhase(phase);
		const before = getOrchestratorState();
		// When a stale client requests packages.
		const outcome = await installUpdatesNow({ scope: "packages" });
		// Then only the existing refusal vocabulary is returned, with no effects.
		expect(outcome).toEqual({
			started: false,
			reason: [
				"downloading",
				"committing",
				"restarting-services",
				"settled",
			].includes(phase)
				? "busy"
				: "not_available",
		});
		expect(getOrchestratorState()).toEqual(before);
		expect(f.stages()).toBe(0);
		expect(f.launches()).toBe(0);
		expect(await f.quarantine.readPending()).toEqual([]);
	},
);

test("scoped live-stream refusal leaves the package offer untouched", async () => {
	// Given a live stream and an offer.
	const f = scopedFixture({ isStreamLive: () => true });
	const before = getOrchestratorState();
	// When packages are requested.
	expect(await installUpdatesNow({ scope: "packages" })).toEqual({
		started: false,
		reason: "stream_active",
	});
	// Then no transition or launch occurred.
	expect(getOrchestratorState()).toEqual(before);
	expect(f.launches()).toBe(0);
});

test("scoped metered refusal clears its pending plan and preserves automation settings", async () => {
	// Given metered-only access without package permission.
	const settings = {
		packagesAuto: false,
		systemAuto: true,
		schedule: { mode: "any-idle" as const, start: "03:00", end: "05:00" },
		channel: "stable" as const,
		allowPackagesOverCellular: false,
		allowSystemOverCellular: true,
	};
	const f = scopedFixture({
		loadSettings: async () => settings,
		onlyMeteredCandidateExists: async () => true,
	});
	// When manual packages bypass idle, but not metered policy.
	expect(await installUpdatesNow({ scope: "packages" })).toEqual({
		started: false,
		reason: "busy",
	});
	// Then the refused plan is not retained or launched; settings were read only.
	expect(await f.quarantine.readPending()).toEqual([]);
	expect(f.launches()).toBe(0);
	expect(settings.packagesAuto).toBe(false);
	expect(settings.allowPackagesOverCellular).toBe(false);
});

test("concurrent scoped install cannot replace the pending plan owner", async () => {
	// Given an accepted first request held while saving its exact plan.
	const f = scopedFixture();
	const saving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const save = f.quarantine.savePending.bind(f.quarantine);
	f.quarantine.savePending = async (plan) => {
		saving.resolve();
		await release.promise;
		await save(plan);
	};
	const first = installUpdatesNow({ scope: "packages" });
	await saving.promise;
	// When another package request arrives.
	const second = await installUpdatesNow({ scope: "packages" });
	release.resolve();
	// Then one launch and one plan survive, and the second request is refused.
	expect(second).toEqual({ started: false, reason: "busy" });
	expect(await first).toEqual({ started: true });
	expect(f.launches()).toBe(1);
	expect(await f.quarantine.readPending()).toEqual([
		{ name: "cerastream", version: "2026.10.1" },
	]);
});

test("scoped refusal retains the booted-version diagnostic", async () => {
	// Given the existing unavailable boot identity diagnostic.
	scopedFixture();
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		phase: "idle",
		failureReason: "booted_version_unknown",
	});
	// When a scoped call arrives, then the existing reason is preserved.
	expect(await installUpdatesNow({ scope: "packages" })).toEqual({
		started: false,
		reason: "booted_version_unknown",
	});
});
