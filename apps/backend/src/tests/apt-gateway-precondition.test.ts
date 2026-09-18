import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import * as gateways from "../modules/network/gateways.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import {
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateSizeRunner,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setAptReachabilityProbeForTest,
	setSoftwareUpdateSizeRunner,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

afterEach(() => {
	resetAptReachabilityProbeForTest();
	resetSoftwareUpdateSizeRunner();
	resetSoftwareUpdateCheckRunner();
	resetSoftwareUpdateState();
	mock.restore();
});

test("apt discovery waits for route application, then requests a fresh unbound family verdict", async () => {
	// Given: route application is pending while the old default would pass HTTP.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	const order: string[] = [];
	let probeAge: number | undefined;
	const repair = spyOn(gateways, "updateGwWrapper").mockImplementation(() => {
		order.push("repair");
		entered.resolve();
		return release.promise;
	});
	setAptReachabilityProbeForTest(async (options) => {
		probeAge = options?.maxAgeMs;
		order.push("family");
		return {
			ipv4: "ok",
			ipv6: "no_route",
			verdict: "force_ipv4",
			used: "ipv4",
			detail: [],
		};
	});
	setSoftwareUpdateSizeRunner(async () => {
		order.push("apt");
		return null;
	});
	// When: discovery starts, neither its family probe nor apt may race the repair.
	await withDeviceType("real", async () => {
		const pending = runUpdateDiscoveryAndReport();
		await Promise.race([entered.promise, pending]);
		expect(order).toEqual(["repair"]);
		release.resolve(true);
		expect(await pending).toBeNull();
	});
	// Then: the elected route is applied before the next apt request is admitted.
	expect(repair).toHaveBeenCalledWith(true);
	expect(order).toEqual(["repair", "family", "apt"]);
	expect(probeAge).toBe(0);
});

test("failed route repair refuses apt even when a stale family probe would report success", async () => {
	// Given: route installation failed, but the old cached family answer is usable.
	spyOn(gateways, "updateGwWrapper").mockResolvedValue(false);
	const probe = mock(
		async () =>
			({
				ipv4: "ok",
				ipv6: "ok",
				verdict: "any",
				used: "any",
				detail: [],
			}) as const,
	);
	setAptReachabilityProbeForTest(probe);
	const apt = mock(async () => null);
	setSoftwareUpdateSizeRunner(apt);
	// When: the next apt operation asks for admission.
	await withDeviceType("real", async () => {
		expect(await runUpdateDiscoveryAndReport()).toBe("repos_unreachable");
	});
	// Then: neither the stale probe nor apt can turn repair failure into success.
	expect(apt).not.toHaveBeenCalled();
	expect(probe).not.toHaveBeenCalled();
	expect(getUpdateState()).toMatchObject({
		kind: "check_failed",
		reason: "repos_unreachable",
	});
});

test("an emulated apt check never mutates the host route", async () => {
	// Given: a dev host and injected read-only discovery.
	const repair = spyOn(gateways, "updateGwWrapper").mockResolvedValue(true);
	setSoftwareUpdateSizeRunner(async () => null);
	// When: emulated discovery runs.
	await withDeviceType("emulated", async () => {
		await runUpdateDiscoveryAndReport();
	});
	// Then: the actual host network is untouched.
	expect(repair).not.toHaveBeenCalled();
});

test("refresh stderr cannot race the next apt discovery with a fire-and-forget repair", async () => {
	// Given: refresh fails, and the next repair remains pending.
	const secondEntered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	const discovered = Promise.withResolvers<void>();
	let repairs = 0;
	spyOn(gateways, "updateGwWrapper").mockImplementation(async () => {
		if (++repairs === 2) {
			secondEntered.resolve();
			return release.promise;
		}
		return true;
	});
	const queue = spyOn(gateways, "queueUpdateGw").mockImplementation(() => {});
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "no_route",
		used: "ipv4",
		verdict: "force_ipv4",
		detail: [],
	}));
	const refresh = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 100,
		stdout: "",
		stderr: "repository TLS reset",
	});
	let aptDiscoveryCalls = 0;
	setSoftwareUpdateSizeRunner(async () => {
		aptDiscoveryCalls++;
		discovered.resolve();
		return null;
	});
	// When: the real refresh continuation tries to launch discovery.
	await withDeviceType("real", async () => {
		expect(triggerManualUpdateCheck()).toBe(true);
		await secondEntered.promise;
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(aptDiscoveryCalls).toBe(0);
		release.resolve(true);
		await discovered.promise;
	});
	// Then: the next request waits; stderr merely controls the existing retry cadence.
	expect(aptDiscoveryCalls).toBe(1);
	expect(queue).not.toHaveBeenCalled();
});

test("detached installation waits for route application before space admission or dispatch", async () => {
	// Given: a real update continuation over the existing isolated transaction fixture.
	await using h = await updateHarness();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	spyOn(gateways, "updateGwWrapper").mockImplementation(() => {
		entered.resolve();
		return release.promise;
	});
	// When: installation reaches its independent network precondition.
	await withDeviceType("real", async () => {
		expect(startSoftwareUpdate()).toEqual({ started: true });
		const finished = h.check();
		await entered.promise;
		expect(h.commands).toEqual([]);
		expect(h.launches).toEqual([]);
		release.resolve(true);
		await finished;
	});
	// Then: only the completed route apply admits the detached apt transaction.
	expect(h.launches).toHaveLength(1);
});
