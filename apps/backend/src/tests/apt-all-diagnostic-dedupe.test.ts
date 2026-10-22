import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import {
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
} from "../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
let dir = "";
let stderr = "";
const commands: string[][] = [];
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

beforeEach(async () => {
	// Given: private capable-image authority, an idle owner, and a command-only port.
	dir = await mkdtemp(join(tmpdir(), "apt-diag-dedupe-"));
	const capability = join(dir, "capabilities.json");
	await writeFile(
		capability,
		JSON.stringify({
			schema: 1,
			features: ["apt-all-packages"],
			apt_uid: 42042,
			ota_uid: 42041,
		}),
	);
	setUpdateCapabilityPathForTest(capability);
	setCeraliveSourcesFileForTest(join(dir, "sources"));
	setUpdateSettingsFilePathForTest(join(dir, "settings.json"));
	resetSoftwareUpdateState();
	commands.length = 0;
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	}));
	setAptCommandRunnerForTest(async (argv) => {
		commands.push([...argv]);
		return argv[1] === "policy"
			? { exitCode: 100, stdout: "", stderr }
			: {
					exitCode: 0,
					stdout: argv[1] === "-s" ? "0 upgraded" : "",
					stderr: "",
				};
	});
	warn = spyOn(logger, "warn");
});

afterEach(async () => {
	warn.mockRestore();
	setAptCommandRunnerForTest(null);
	setUpdateCapabilityPathForTest(null);
	setCeraliveSourcesFileForTest(null);
	setUpdateSettingsFilePathForTest(null);
	resetAptReachabilityProbeForTest();
	resetSoftwareUpdateState();
	notificationRemove("ceralive_update_failed");
	await rm(dir, { recursive: true, force: true });
});

it("withholds folded-credential bytes when discovery logs its refusal", async () => {
	// Given: the reviewer's independently reproduced input.
	stderr = "Authorization: Bearer\n ALPHA9384";
	// When: the actual discovery/handling catch runs, not the logger backstop.
	await runUpdateDiscoveryAndReport();
	// Then
	expect(warn).toHaveBeenCalledWith("Capable APT update refused", {
		reason: "discovery_failed",
		step: "source-policy",
		exit: 100,
		detail: "[REDACTED]",
	});
	expect(JSON.stringify(warn.mock.calls)).not.toContain("ALPHA9384");
	expect(getUpdateState()).toEqual({
		kind: "failed",
		reason: "discovery_failed",
	});
	expect(
		commands.every((argv) =>
			["-s", "policy", "showhold"].includes(argv[1] ?? ""),
		),
	).toBe(true);
});

it("logs distinct truncated-detail-dedupe failures when their safe tails differ", async () => {
	// Given: both failures have exactly the same displayed prefix.
	const prefix = "e".repeat(520);
	// When: a single failure sequence changes only beyond the display horizon.
	for (const tail of [" alpha failure", " beta failure", " beta failure"]) {
		stderr = prefix + tail;
		await runUpdateDiscoveryAndReport();
	}
	// Then: a changed tail logs, an identical repeat does not.
	expect(warn).toHaveBeenCalledTimes(2);
	for (const call of warn.mock.calls) {
		expect(JSON.stringify(call)).toBe(
			JSON.stringify([
				"Capable APT update refused",
				{
					reason: "discovery_failed",
					step: "source-policy",
					exit: 100,
					detail: "e".repeat(300),
				},
			]),
		);
	}
});

it("suppresses identical safe failures when they recur without a changed tail", async () => {
	// Given
	stderr = "E: repository unavailable";
	// When
	for (let attempt = 0; attempt < 3; attempt++)
		await runUpdateDiscoveryAndReport();
	// Then
	expect(warn).toHaveBeenCalledTimes(1);
});

it("logs returning transitions when an earlier full safe diagnostic recurs", async () => {
	// Given
	const prefix = "e".repeat(520);
	// When
	for (const tail of [" alpha failure", " beta failure", " alpha failure"]) {
		stderr = prefix + tail;
		await runUpdateDiscoveryAndReport();
	}
	// Then
	expect(warn).toHaveBeenCalledTimes(3);
});

it("does not fingerprint secret bytes when only redacted values change", async () => {
	// Given: only credential-bearing bytes change; safe diagnostic is identical.
	// When
	for (const value of ["ALPHA9384", "BRAVO8273"]) {
		stderr = `Authorization: Bearer\n ${value}`;
		await runUpdateDiscoveryAndReport();
	}
	// Then: neither a warning transition nor its metadata depends on raw secrets.
	expect(warn).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ALPHA9384|BRAVO8273/);
});
