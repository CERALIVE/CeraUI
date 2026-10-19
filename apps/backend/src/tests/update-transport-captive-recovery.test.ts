import { beforeEach, expect, test } from "bun:test";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { defaultOrchestratorRuntimeDeps } from "../modules/system/update-orchestrator/runtime.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const { t, pinned } = aptEntryHarness();
const samples = [sample("eth0", "ethernet", 4, "captive-tls")];
let refresh: SpawnWithTimeoutResult;

beforeEach(async () => {
	updates.resetSoftwareUpdateState();
	samples.splice(
		0,
		samples.length,
		sample("eth0", "ethernet", 4, "captive-tls"),
	);
	await pinned(samples);
	refresh = { exitCode: 0, stdout: "", stderr: "" };
	updates.setAptCommandRunnerForTest(async (argv) => {
		t.commands.push({ argv: [...argv], pinned: t.fixture?.active() ?? false });
		return argv[1] === "update"
			? refresh
			: {
					exitCode: 0,
					stdout: argv[1] === "-s" ? "0 upgraded, 0 newly installed.\n" : "",
					stderr: "",
				};
	});
});

test("the next orchestrator check clears captive failure after a successful pinned refresh", async () => {
	await withDeviceType("real", async () => {
		// Given a real captive selection, then the same uplink restored without resetting any owner.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBe(
			"captive_portal",
		);
		expect(updates.getUpdateState()).toMatchObject({
			kind: "check_failed",
			reason: "captive_portal",
			reachability: { ipv4: "captive", used: "none" },
		});
		expect(t.commands).toEqual([]);
		samples.splice(0, samples.length, sample("eth0", "ethernet", 4));
		// When the next Check uses the production package-check port.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBeNull();
		// Then a clear probe and fresh lists produce idle, not the previous captive reason.
		expect(updates.getUpdateState()).toMatchObject({
			kind: "idle",
			reachability: { ipv4: "ok", used: "ipv4" },
		});
		const refreshed = t.commands.filter(({ argv }) => argv[1] === "update");
		expect(refreshed).toHaveLength(1);
		expect(refreshed[0]).toMatchObject({ pinned: true });
		expect(refreshed[0]?.argv).toContain("Acquire::ForceIPv4=true");
	});
});

test("clear probes cannot hide a fresh captive APT refresh verdict", async () => {
	// Given clear probes but an actual refresh returning the captive signature.
	samples.splice(0, samples.length, sample("eth0", "ethernet", 4));
	refresh = {
		exitCode: 100,
		stdout: "",
		stderr:
			"Clearsigned file isn't valid, got 'NOSPLIT' (does the network require authentication?)",
	};
	await withDeviceType("real", async () => {
		// When the production orchestrator package check refreshes and discovers no packages.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBe(
			"captive_portal",
		);
		// Then stale-list discovery must not erase this cycle's real failure.
		expect(updates.getUpdateState()).toMatchObject({
			kind: "check_failed",
			reason: "captive_portal",
			reachability: { ipv4: "ok", used: "ipv4" },
		});
	});
});

test("benign refresh warnings still allow a successful orchestrator check", async () => {
	// Given a clear transport and an exit-zero refresh with a benign warning.
	samples.splice(0, samples.length, sample("eth0", "ethernet", 4));
	refresh = {
		exitCode: 0,
		stdout: "",
		stderr: "W: Target Packages is configured multiple times",
	};
	await withDeviceType("real", async () => {
		// When the production package-check port completes discovery.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBeNull();
		// Then warnings are not converted into a failed check.
		expect(updates.getUpdateState()).toMatchObject({ kind: "idle" });
	});
});

test("a skipped orchestrator refresh preserves the prior captive evidence", async () => {
	await withDeviceType("real", async () => {
		// Given a captive check followed by a refused refresh dispatch.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBe(
			"captive_portal",
		);
		const prior = updates.getUpdateState();
		updates.setSoftwareUpdateCheckRunner(() => false);
		samples.splice(0, samples.length, sample("eth0", "ethernet", 4));
		// When Check cannot start, then it must not claim a new healthy observation.
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBe("busy");
		expect(updates.getUpdateState()).toEqual(prior);
		expect(t.commands).toEqual([]);
	});
});

test("failed refresh cannot become success through stale-list discovery", async () => {
	// Given a clear transport but a local apt failure, not a failover-class network error.
	samples.splice(0, samples.length, sample("eth0", "ethernet", 4));
	refresh = {
		exitCode: 100,
		stdout: "",
		stderr: "E: Could not get lock /var/lib/apt/lists/lock",
	};
	await withDeviceType("real", async () => {
		// When the check discovers zero packages from the old lists.
		expect(
			await defaultOrchestratorRuntimeDeps.runPackageCheck(),
		).not.toBeNull();
		// Then both return value and wire retain failure instead of publishing up-to-date.
		expect(updates.getUpdateState()).toMatchObject({
			kind: "check_failed",
			reason: "refresh_failed",
		});
		expect(t.commands.filter(({ argv }) => argv[1] === "update")).toHaveLength(
			1,
		);
	});
});
