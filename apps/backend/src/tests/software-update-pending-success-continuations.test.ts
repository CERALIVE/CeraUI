import { expect, spyOn, test } from "bun:test";
import type { AptReachability } from "../modules/system/apt-reachability.ts";
import * as updates from "../modules/system/software-updates.ts";
import * as capabilities from "../modules/system/update-capabilities.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { pendingSuccessFixture } from "./helpers/pending-success-fixture.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

const REACHABLE: AptReachability = {
	ipv4: "ok",
	ipv6: "ok",
	used: "any",
	verdict: "any",
	detail: [],
};

test("discovery admitted before network preparation cannot submit apt after success observation", async () => {
	// Given an admitted discovery parked at network preparation.
	await using h = await updateHarness();
	using f = pendingSuccessFixture();
	const probed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<AptReachability>();
	updates.setAptReachabilityProbeForTest(() => {
		probed.resolve();
		return release.promise;
	});
	const commands: string[][] = [];
	updates.setAptCommandRunnerForTest(async (argv) => {
		commands.push(argv);
		return {
			exitCode: 0,
			stdout: "0 upgraded, 0 newly installed, 0 to remove.\n",
			stderr: "",
		};
	});
	try {
		const discovery = updates.runUpdateDiscoveryAndReport();
		await probed.promise;
		// When success is observed before the preparation result returns.
		pendingPackageSuccess.observe();
		release.resolve(REACHABLE);
		expect(await discovery).toBe("discovery_failed");
		// Then no apt command is submitted and the single-flight latch is released.
		expect(commands).toHaveLength(0);
		pendingPackageSuccess.acknowledge(f.success);
		expect(await updates.runUpdateDiscoveryAndReport()).toBeNull();
		expect(commands).toHaveLength(1);
		expect(h.launches).toHaveLength(0);
	} finally {
		release.resolve(REACHABLE);
		updates.setAptCommandRunnerForTest(null);
	}
});

test("refresh admitted before network preparation skips its command and clears the install latch", async () => {
	// Given an accepted legacy Install whose refresh waits for network preparation.
	await using h = await updateHarness();
	using _f = pendingSuccessFixture();
	updates.resetSoftwareUpdateCheckRunner();
	const probed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<AptReachability>();
	updates.setAptReachabilityProbeForTest(() => {
		probed.resolve();
		return release.promise;
	});
	const commands: string[][] = [];
	updates.setAptCommandRunnerForTest(async (argv) => {
		commands.push(argv);
		return { exitCode: 100, stdout: "", stderr: "" };
	});
	try {
		expect(updates.startSoftwareUpdate()).toEqual({ started: true });
		await probed.promise;
		// When pending success appears before the new refresh command.
		pendingPackageSuccess.observe();
		release.resolve(REACHABLE);
		await h.settled();
		// Then refresh submits nothing and neither progress nor refresh flags remain wedged.
		expect(commands).toHaveLength(0);
		expect(updates.isUpdating()).toBe(false);
		expect(h.launches).toHaveLength(0);
	} finally {
		release.resolve(REACHABLE);
		updates.setAptCommandRunnerForTest(null);
	}
});

test("discovery cannot submit after its awaited capability read when success became pending", async () => {
	// Given discovery already passed network preparation and is awaiting image capabilities.
	await using h = await updateHarness();
	using _f = pendingSuccessFixture();
	const read = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cap = spyOn(capabilities, "readUpdateCapabilities").mockImplementation(
		async () => {
			read.resolve();
			await release.promise;
			return { mode: "legacy", features: [] };
		},
	);
	const commands: string[][] = [];
	updates.setAptCommandRunnerForTest(async (argv) => {
		commands.push(argv);
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	try {
		const discovery = updates.runUpdateDiscoveryAndReport();
		await read.promise;
		// When completion is observed before the capability result returns.
		pendingPackageSuccess.observe();
		release.resolve();
		// Then the legacy dry-run command never reaches the command runner.
		expect(await discovery).toBe("discovery_failed");
		expect(commands).toHaveLength(0);
		expect(h.launches).toHaveLength(0);
	} finally {
		release.resolve();
		cap.mockRestore();
		updates.setAptCommandRunnerForTest(null);
	}
});

test("an already-submitted discovery command cannot authorize a new held-back command while pending", async () => {
	// Given the first apt dry-run was submitted before observation.
	await using h = await updateHarness();
	using _f = pendingSuccessFixture();
	const submitted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const commands: string[][] = [];
	updates.setAptCommandRunnerForTest(async (argv) => {
		commands.push(argv);
		submitted.resolve();
		await release.promise;
		return {
			exitCode: 1,
			stdout:
				"The following packages have been kept back:\n  cerastream\n0 upgraded, 0 newly installed, 0 to remove.\n",
			stderr: "",
		};
	});
	try {
		const discovery = updates.runUpdateDiscoveryAndReport();
		await submitted.promise;
		// When pending success appears before the first command settles.
		pendingPackageSuccess.observe();
		release.resolve();
		// Then the submitted command is not cancelled, but no second command is issued.
		expect(await discovery).toBe("discovery_failed");
		expect(commands).toHaveLength(1);
		expect(h.launches).toHaveLength(0);
	} finally {
		release.resolve();
		updates.setAptCommandRunnerForTest(null);
	}
});
