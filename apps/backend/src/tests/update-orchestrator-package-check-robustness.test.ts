import { afterEach, beforeEach, expect, test } from "bun:test";
import { setup } from "../modules/setup.ts";
import { setAptTransportDepsForTest } from "../modules/system/apt-transport.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import {
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

useSessionOwnerForFile();
const { t, pinned } = aptEntryHarness();
const enabled = setup.apt_update_enabled;
const deviceType = process.env.CERALIVE_DEVICE_TYPE;
beforeEach(() => {
	process.env.CERALIVE_DEVICE_TYPE = "real";
});
afterEach(() => {
	if (deviceType === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
	else process.env.CERALIVE_DEVICE_TYPE = deviceType;
	setup.apt_update_enabled = enabled;
	setStreamLivenessSourceForTest(null);
	resetOrchestratorRuntimeForTest();
});

function realPackagePort(overrides: Partial<OrchestratorRuntimeDeps> = {}) {
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			runPackageCheck: defaultOrchestratorRuntimeDeps.runPackageCheck,
			getPackageInstallWireState: updates.getUpdateState,
			isUpdateAdmissionReady: async () => true,
			...overrides,
		}),
	);
	setOrchestratorStateForTest(initialOrchestratorState(0));
}

test.each(["manual", "scheduled"] as const)(
	"%s checks skip deliberately disabled APT without failure backoff",
	async (entry) => {
		// Given updates deliberately disabled, rather than a concurrent refresh.
		await pinned([sample("eth0", "ethernet", 4)]);
		setup.apt_update_enabled = false;
		realPackagePort();
		await withDeviceType("real", async () => {
			// When the operator or scheduler performs two checks.
			for (let i = 0; i < 2; i++) {
				if (entry === "manual") await checkUpdatesNow();
				else await runOrchestratorTick();
			}
			// Then disabled is neither a failure nor permission to invoke APT.
			expect(getOrchestratorState().packageCheck).toEqual(
				initialOrchestratorState(0).packageCheck,
			);
			expect(t.commands).toEqual([]);
			expect(
				getPersistentNotifications(true).show.some(
					(n) => n.name === "update:refused:packages:busy",
				),
			).toBe(false);
		});
	},
);

test.each([
	["scheduled", true],
	["scheduled", false],
	["manual", true],
] as const)(
	"%s OS checks remain eligible with APT disabled and packagesAuto=%s",
	async (entry, packagesAuto) => {
		// Given disabled APT on an OS-capable image with both clocks due.
		await pinned([sample("eth0", "ethernet", 4)], ["apt-all-packages"]);
		setup.apt_update_enabled = false;
		let now = 1_000_000;
		let osChecks = 0;
		realPackagePort({
			now: () => now,
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			loadSettings: async () => ({
				packagesAuto,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: true,
			}),
			checkOsManifest: async () => {
				osChecks++;
				return {
					available: false,
					rateLimited: false,
					failed: false,
					reason: "",
				};
			},
		});
		// When a manual Check runs, or 96 scheduled ticks span 48 simulated hours.
		await withDeviceType("real", async () => {
			if (entry === "manual") {
				expect(await checkUpdatesNow()).toEqual({ started: true });
			} else {
				for (let tick = 0; tick < 96; tick++) {
					await runOrchestratorTick();
					now += 30 * 60_000;
				}
			}
		});
		// Then OS discovery keeps its cadence without APT commands or package failures.
		expect(osChecks).toBe(entry === "manual" ? 1 : 4);
		expect(t.commands).toEqual([]);
		expect(getOrchestratorState().packageCheck).toEqual(
			initialOrchestratorState(0).packageCheck,
		);
		expect(
			getPersistentNotifications(true).show.some((n) =>
				n.name.startsWith("update:refused:packages:"),
			),
		).toBe(false);
	},
);

test("a live stream still yields busy without refreshing", async () => {
	// Given enabled updates and a live stream.
	await pinned([sample("eth0", "ethernet", 4)]);
	setStreamLivenessSourceForTest(() => "streaming");
	// When the real package port attempts a check.
	const result = await defaultOrchestratorRuntimeDeps.runPackageCheck();
	// Then existing busy semantics and zero refreshes are retained.
	expect(result).toBe("busy");
	expect(t.commands).toEqual([]);
});

test("a concurrent legacy refresh still yields busy without a second refresh", async () => {
	// Given a real refresh held at the command port.
	await pinned([sample("eth0", "ethernet", 4)]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	updates.setAptCommandRunnerForTest(async (argv) => {
		t.commands.push({ argv: [...argv], pinned: true });
		if (argv[1] === "update") {
			entered.resolve();
			await release.promise;
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	const first = defaultOrchestratorRuntimeDeps.runPackageCheck();
	await entered.promise;
	try {
		// When a concurrent check arrives.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBe("busy");
		// Then only the first refresh was submitted.
		expect(t.commands.filter((c) => c.argv[1] === "update")).toHaveLength(1);
	} finally {
		release.resolve();
		await first;
	}
});

test("same-cycle stale-list availability cannot hide a failed refresh", async () => {
	// Given a captive refresh followed by a clear discovery path with stale upgrades.
	const pins = await pinned([sample("eth0", "ethernet", 4)]);
	let selections = 0;
	setAptTransportDepsForTest({
		select: async () =>
			rankTransports([
				sample(
					"eth0",
					"ethernet",
					4,
					++selections === 1 ? "captive-tls" : "clear",
				),
			]),
		pin: pins.pin,
		ownership: pins.ownership,
	});
	// When the full cycle checks packages.
	const outcome = await defaultOrchestratorRuntimeDeps.runPackageCheck();
	// Then discovery cannot publish a new available offer after that failure.
	expect(outcome).toBe("captive_portal");
	expect(updates.getUpdateState()).toMatchObject({
		kind: "check_failed",
		reason: "captive_portal",
	});
});

test("an unexpected refresh exception settles Check and leaves subsequent checks runnable", async () => {
	// Given an unclassified throw in the legacy refresh probe.
	await pinned([sample("eth0", "ethernet", 4)], ["apt-all-packages"]);
	updates.setAptReachabilityProbeForTest(async () => {
		throw new TypeError("probe internal failure");
	});
	realPackagePort();
	// When the real scheduler and then the manual entrypoint check.
	await runOrchestratorTick();
	expect(await checkUpdatesNow()).toEqual({ started: true });
	// Then both ports settle, the phase is not wedged, and failures have a typed reason.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
	});
	expect(getOrchestratorState().packageCheck.consecutiveFailures).toBe(2);
	expect(updates.getUpdateState()).toMatchObject({
		kind: "check_failed",
		reason: "discovery_failed",
	});
});
