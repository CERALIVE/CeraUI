import { expect, spyOn, test } from "bun:test";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { stopPackageInstallUnitForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { FETCH_FAILURE, sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

const RANKED = [sample("eth0", "ethernet", 6), sample("wlan0", "wifi", 4)];
const { t, install } = aptEntryHarness();

test("install fetches under the pin with failover, then launches the unit unpinned", async () => {
	// Given the IPv6 archive fetch cannot connect.
	let fetches = 0;
	t.download = async () =>
		++fetches === 1
			? FETCH_FAILURE
			: { exitCode: 0, stdout: "Get:1 x\n", stderr: "" };
	await withDeviceType("real", async () => {
		const { h, launches, run } = await install(RANKED);
		await using _h = h;
		// When the install continuation runs.
		await run();
		// Then every apt-get ran pinned, the fetch moved to IPv4, and the unit launched after teardown.
		const fetched = t.commands.filter(({ argv }) => argv[1] === "-d");
		expect(fetched.map(({ argv }) => argv.at(-1))).toEqual([
			"Acquire::ForceIPv6=true",
			"Acquire::ForceIPv4=true",
		]);
		expect(t.commands.every(({ pinned }) => pinned)).toBe(true);
		expect(launches).toEqual([false]);
	});
});

test("install whose every pair fails to fetch ends on the existing failed-transaction path", async () => {
	// Given both pairs fail to fetch archives.
	t.download = async () => FETCH_FAILURE;
	await withDeviceType("real", async () => {
		const { h, launches, run } = await install(RANKED);
		await using _h = h;
		// When the install continuation runs.
		await run();
		// Then the unit never launched and apt's own failure is the recorded reason.
		expect(launches).toEqual([]);
		expect(updates.getUpdateState()).toMatchObject({
			kind: "failed",
			reason: FETCH_FAILURE.stderr.trim(),
		});
	});
});

test("install with no healthy pair refuses with the existing reason and fetches nothing", async () => {
	await withDeviceType("real", async () => {
		// Given only a captive pair.
		const { h, launches, run } = await install([
			sample("eth0", "ethernet", 4, "captive-http"),
		]);
		await using _h = h;
		// When the install continuation runs.
		await run();
		// Then the existing captive refusal stands and nothing was fetched or launched.
		expect(updates.getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "A captive portal prevented the software update.",
		});
		expect(t.commands.some(({ argv }) => argv[1] === "-d")).toBe(false);
		expect(launches).toEqual([]);
	});
});

test("a stream start during the pinned fetch aborts it, releases the rule and launches nothing", async () => {
	const fetching = Promise.withResolvers<void>();
	t.download = (signal) => {
		fetching.resolve();
		return new Promise((resolve) =>
			signal?.addEventListener("abort", () =>
				resolve({ exitCode: 0, stdout: "", stderr: "" }),
			),
		);
	};
	await withDeviceType("real", async () => {
		// Given the install is fetching under the pin.
		const { h, pins, launches, run } = await install(RANKED);
		await using _h = h;
		const pending = run();
		await fetching.promise;
		expect(pins.active()).toBe(true);
		spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
			exitCode: 0,
			stdout: "",
			stderr: "",
		});
		// When the orchestrator stops the package install for an admitted stream.
		await stopPackageInstallUnitForStream();
		await pending;
		// Then the rule is gone and the unit never launched.
		expect(pins.active()).toBe(false);
		expect(launches).toEqual([]);
		expect(updates.isUpdating()).toBe(false);
	});
});
