/// <reference types="bun" />

import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as updates from "../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import { opiAptSection } from "./helpers/apt-opi-capture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

it("forces English child output in discovery and pinned recheck despite inherited locale", async () => {
	// Given: a capable fixture and a genuinely non-C parent environment.
	const dir = await mkdtemp(join(tmpdir(), "apt-locale-"));
	const previous = {
		LC_ALL: process.env.LC_ALL,
		LANG: process.env.LANG,
		LANGUAGE: process.env.LANGUAGE,
	};
	const observed: { command: string[]; locale: unknown }[] = [];
	try {
		Object.assign(process.env, {
			LC_ALL: "es_MX.UTF-8",
			LANG: "es_MX.UTF-8",
			LANGUAGE: "es:fr",
		});
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
		updates.setAptCommandRunnerForTest(async (argv, options) => {
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					"console.log(JSON.stringify({LC_ALL:process.env.LC_ALL,LANG:process.env.LANG,LANGUAGE:process.env.LANGUAGE??null}))",
				],
				{ env: options?.env ?? process.env, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
			observed.push({ command: [...argv], locale: JSON.parse(stdout) });
			if (argv.includes("install"))
				return {
					exitCode: 100,
					stdout: "",
					stderr: "locale test stops before effects",
				};
			const section =
				argv[1] === "-s"
					? "SIM"
					: argv[1] === "showhold"
						? "HOLDS"
						: argv[2]
							? `PKG-${argv[2]}`
							: "POLICY";
			return { exitCode: 0, stdout: opiAptSection(section), stderr: "" };
		});
		// When: cross both real command boundaries; refuse before space/download effects.
		await updates.runUpdateDiscoveryAndReport();
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
		expect(updates.startSoftwareUpdate()).toEqual({ started: true });
		await done.promise;
		// Then
		expect(observed.some(({ command }) => command.includes("upgrade"))).toBe(
			true,
		);
		expect(observed.some(({ command }) => command.includes("install"))).toBe(
			true,
		);
		for (const { locale } of observed)
			expect(locale).toEqual({ LC_ALL: "C", LANG: "C", LANGUAGE: null });
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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
