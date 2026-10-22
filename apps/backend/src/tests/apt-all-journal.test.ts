import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";
import {
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
import { opiAptSection } from "./helpers/apt-opi-capture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
let directory = "";
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "apt-journal-"));
	const capability = join(directory, "capabilities.json");
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
	setCeraliveSourcesFileForTest(join(directory, "sources"));
	setUpdateSettingsFilePathForTest(join(directory, "settings.json"));
	resetSoftwareUpdateState();
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	}));
});
afterEach(async () => {
	setAptCommandRunnerForTest(null);
	setUpdateCapabilityPathForTest(null);
	setCeraliveSourcesFileForTest(null);
	setUpdateSettingsFilePathForTest(null);
	resetAptReachabilityProbeForTest();
	resetSoftwareUpdateState();
	notificationRemove("ceralive_update_failed");
	await rm(directory, { recursive: true, force: true });
});

const refusal = z.object({
	level: z.literal("warn"),
	msg: z.literal("Capable APT update refused"),
	meta: z.object({
		reason: z.literal("discovery_failed"),
		stage: z.string(),
		detail: z.string().max(300),
	}),
});

it.each([
	["inventory", "source-policy"],
	["package", "package-policy"],
	["parse", "parse"],
	["simulation", "simulation"],
	["holds", "simulation"],
] as const)(
	"carries bounded safe context into production journal JSON for %s",
	async (command, stage) => {
		// Given: real captured success replies, with one refused command or parse row.
		const stderr = `E: journal-${command} ${"x".repeat(420)}\nAuthorization: Bearer\n fixture-never-log`;
		setAptCommandRunnerForTest(async (argv) => {
			const operation =
				argv[1] === "-s"
					? "simulation"
					: argv[1] === "showhold"
						? "holds"
						: argv[2]
							? "package"
							: "inventory";
			if (operation === command) return { exitCode: 100, stdout: "", stderr };
			const section =
				operation === "simulation"
					? "SIM"
					: operation === "holds"
						? "HOLDS"
						: operation === "package"
							? `PKG-${argv[2]}`
							: "POLICY";
			return {
				exitCode: 0,
				stdout:
					command === "parse" && operation === "simulation"
						? `Inst journal-parse invalid ${"x".repeat(420)}\n`
						: opiAptSection(section),
				stderr: "",
			};
		});
		clearRecentLogLines();
		// When
		await runUpdateDiscoveryAndReport();
		// Then: inspect the real production formatter's output, not logger arguments.
		const record = getRecentLogLines()
			.map((line) => refusal.safeParse(JSON.parse(line)))
			.find((entry) => entry.success);
		expect(record?.data?.meta.stage).toBe(stage);
		expect(record?.data?.meta.detail).toContain(`journal-${command}`);
		const rendered = getRecentLogLines().join("\n");
		expect(rendered).not.toContain("fixture-never-log");
		expect(rendered).not.toContain("x".repeat(301));
	},
);
