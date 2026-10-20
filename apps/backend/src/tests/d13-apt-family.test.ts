import { expect, spyOn, test } from "bun:test";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { pendingAwareAptSpaceDeps } from "../modules/system/software-update-pending-effects.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import * as updates from "../modules/system/software-updates.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { UpdateTransferError } from "../modules/system/update-transport/pin.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { FETCH_FAILURE, sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const { t, pinned, install } = aptEntryHarness();
const ranked = [sample("eth0", "ethernet", 6), sample("wlan0", "wifi", 4)];

test("pins URI estimation alongside the rest of install preflight", async () => {
	// Given a real install with a recording URI-estimation port.
	await withDeviceType("real", async () => {
		const { h, pins, run } = await install(ranked);
		await using _h = h;
		const original = pendingAwareAptSpaceDeps.run;
		const seen: boolean[] = [];
		spyOn(pendingAwareAptSpaceDeps, "run").mockImplementation(
			async (argv, options) => {
				if (argv.includes("--print-uris")) seen.push(pins.active());
				return original(argv, options);
			},
		);
		// When space admission estimates download bytes.
		await run();
		// Then its apt-get command has the same routing authority as other local work.
		expect(seen).toEqual([true]);
	});
});

test("local discovery receives the actual family when OS holds the original winner", async () => {
	// Given the shared OS hold suppresses the original IPv6 winner.
	const pins = await pinned(ranked);
	await expect(
		pins.pin.run("os", rankTransports(ranked.slice(0, 1)), async () => {
			throw new UpdateTransferError("blocked");
		}),
	).rejects.toBeInstanceOf(UpdateTransferError);
	const seen: string[] = [];
	updates.setSoftwareUpdateSizeRunner(async (attempt) => {
		seen.push(attempt.verdict);
		return null;
	});
	// When real APT discovery chooses the remaining IPv4 pair.
	await withDeviceType("real", async () => {
		await updates.runUpdateDiscoveryAndReport();
	});
	// Then argv/report authority comes from that pair, not the stale ranking winner.
	expect(seen).toEqual(["force_ipv4"]);
});

test("passes the successful failover family and matching install argv to the detached unit", async () => {
	// Given IPv6 fails and the pinned download completes on IPv4.
	await withDeviceType("real", async () => {
		const { h, run } = await install(ranked);
		await using _h = h;
		let attempts = 0;
		t.download = async () =>
			++attempts === 1
				? FETCH_FAILURE
				: { exitCode: 0, stdout: "", stderr: "" };
		const seen: { family: string; args: readonly string[] }[] = [];
		spyOn(transaction, "runDetachedAptAll").mockImplementation(
			async (args, family) => {
				seen.push({ args, family });
				return 100;
			},
		);
		// When the detached commit/download command is constructed.
		await run();
		// Then no stale IPv6 option survives the successful failover.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.family).toBe("force_ipv4");
		expect(seen[0]?.args).toContain("Acquire::ForceIPv4=true");
		expect(seen[0]?.args).not.toContain("Acquire::ForceIPv6=true");
	});
});
