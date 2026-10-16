import { expect, test } from "bun:test";
import * as gateways from "../modules/network/gateways.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { FETCH_FAILURE, sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

const RANKED = [sample("eth0", "ethernet", 6), sample("wlan0", "wifi", 4)];
const { t, pinned } = aptEntryHarness();

test("discovery runs its simulations under the apt pin of the selected family", async () => {
	// Given IPv6 Ethernet wins the per-transaction selection.
	const pins = await pinned(RANKED);
	const seen: string[] = [];
	updates.setSoftwareUpdateSizeRunner(async (reachability) => {
		seen.push(`${reachability.verdict}:${pins.active()}`);
		return null;
	});
	// When discovery runs on a real device.
	await withDeviceType("real", async () => {
		expect(await updates.runUpdateDiscoveryAndReport()).toBeNull();
	});
	// Then no unbound probe or host route repair decided the transaction.
	expect(seen).toEqual(["force_ipv6:true"]);
	expect(pins.active()).toBe(false);
	expect(t.legacyProbe).not.toHaveBeenCalled();
	expect(gateways.updateGwWrapper).not.toHaveBeenCalled();
});

test("the package-list refresh fails over to the next pair under the pin", async () => {
	// Given the IPv6 refresh cannot connect.
	await pinned(RANKED);
	const refreshed = Promise.withResolvers<void>();
	updates.setSoftwareUpdateSizeRunner(async () => {
		refreshed.resolve();
		return null;
	});
	let refreshes = 0;
	updates.setAptCommandRunnerForTest(async (argv) => {
		t.commands.push({ argv: [...argv], pinned: t.fixture?.active() ?? false });
		return argv[1] === "update" && ++refreshes === 1
			? FETCH_FAILURE
			: { exitCode: 0, stdout: "", stderr: "" };
	});
	// When the legacy check runs.
	await withDeviceType("real", async () => {
		expect(updates.triggerManualUpdateCheck()).toBe(true);
		await refreshed.promise;
	});
	// Then each refresh ran pinned with its own family flag.
	const runs = t.commands.filter(({ argv }) => argv[1] === "update");
	expect(runs.map(({ argv }) => argv.at(-1))).toEqual([
		"Acquire::ForceIPv6=true",
		"Acquire::ForceIPv4=true",
	]);
	expect(runs.every(({ pinned }) => pinned)).toBe(true);
});

test.each([
	[
		"captive",
		[sample("eth0", "ethernet", 4, "captive-http")],
		"captive_portal",
	],
	[
		"unreachable",
		[sample("eth0", "ethernet", 4, "no-route")],
		"repos_unreachable",
	],
] as const)(
	"%s selection refuses discovery before any apt command or rule",
	async (_name, samples, reason) => {
		// Given no healthy pair.
		const pins = await pinned(samples);
		// When discovery runs; Then it refuses with the existing typed reason.
		await withDeviceType("real", async () => {
			expect(await updates.runUpdateDiscoveryAndReport()).toBe(reason);
		});
		expect(t.commands).toEqual([]);
		expect(pins.calls.some((line) => line.includes("rule add"))).toBe(false);
	},
);

test("an image without transport-uidrange keeps the unbound legacy preflight", async () => {
	// Given a capable image that does not route apt_uid.
	const pins = await pinned(RANKED, ["apt-all-packages"]);
	t.legacyProbe.mockResolvedValueOnce({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	});
	updates.setSoftwareUpdateSizeRunner(async () => null);
	// When discovery runs; Then only the legacy probe decided it.
	await withDeviceType("real", async () => {
		await updates.runUpdateDiscoveryAndReport();
	});
	expect(t.legacyProbe).toHaveBeenCalledTimes(1);
	expect(pins.calls).toEqual([]);
});
