/// <reference types="bun" />

import { expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAptSpaceDeps } from "../modules/system/apt-space-admission.ts";
import * as updates from "../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import { opiAptSection, opiNginxPairs } from "./helpers/apt-opi-capture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

it("passes the exit-zero fallback-solver recheck before the independent space refusal", async () => {
	// Given: captured policies/rows, with install-shaped lists and real progress bytes.
	const dir = await mkdtemp(join(tmpdir(), "apt-solver-boundary-"));
	const commands: string[][] = [];
	const recheck = `Reading package lists...
Building dependency tree...
Reading state information...
Solving dependencies...
The following additional packages will be installed:
  nginx-common nginx-light
The following NEW packages will be installed:
  nginx-light
The following packages will be upgraded:
  nginx nginx-common
${opiAptSection("SIM")}`;
	const space = spyOn(defaultAptSpaceDeps, "run").mockResolvedValue({
		exitCode: 100,
		stdout: "",
		stderr: "fixture stops before cache or install effects",
	});
	try {
		await writeFile(
			join(dir, "cap.json"),
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages"],
				apt_uid: 42042,
				ota_uid: 42041,
			}),
		);
		setUpdateCapabilityPathForTest(join(dir, "cap.json"));
		setCeraliveSourcesFileForTest(join(dir, "sources"));
		setUpdateSettingsFilePathForTest(join(dir, "settings.json"));
		updates.resetSoftwareUpdateState();
		updates.setAptReachabilityProbeForTest(async () => ({
			ipv4: "ok",
			ipv6: "ok",
			used: "any",
			verdict: "any",
			detail: [],
		}));
		updates.setAptCommandRunnerForTest(async (argv) => {
			commands.push([...argv]);
			const section =
				argv[1] === "-s"
					? "SIM"
					: argv[1] === "showhold"
						? "HOLDS"
						: argv[2]
							? `PKG-${argv[2]}`
							: "POLICY";
			return {
				exitCode: 0,
				stdout: argv.includes("install") ? recheck : opiAptSection(section),
				stderr: "",
			};
		});
		await updates.runUpdateDiscoveryAndReport();
		expect(updates.getUpdateState()).toMatchObject({
			kind: "available",
			actionable_count: 3,
		});
		const done = Promise.withResolvers<void>();
		updates.setSoftwareUpdateCheckRunner((callback) => {
			queueMicrotask(() =>
				Promise.resolve(callback(null, 0)).then(
					() => done.resolve(),
					done.reject,
				),
			);
			return true;
		});
		// When
		expect(updates.startSoftwareUpdate()).toEqual({ started: true });
		await done.promise;
		// Then: the parser accepted the exact pins, not merely the dispatch acknowledgement.
		expect(commands.find((argv) => argv.includes("install"))).toEqual(
			expect.arrayContaining(
				opiNginxPairs.map(({ name, version }) => `${name}=${version}`),
			),
		);
		expect(space).toHaveBeenCalledTimes(1);
		expect(updates.getUpdateState()).toMatchObject({
			kind: "update_preflight_failed",
			preflight_reason: "pre_clean_failed",
		});
	} finally {
		space.mockRestore();
		updates.setAptCommandRunnerForTest(null);
		updates.resetSoftwareUpdateCheckRunner();
		updates.resetAptReachabilityProbeForTest();
		updates.resetSoftwareUpdateState();
		setUpdateCapabilityPathForTest(null);
		setCeraliveSourcesFileForTest(null);
		setUpdateSettingsFilePathForTest(null);
		notificationRemove("ceralive_update_failed");
		await rm(dir, { recursive: true, force: true });
	}
});
