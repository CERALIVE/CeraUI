import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("offers all three captured OPI security upgrades through real capable discovery", async () => {
	// Given
	const dir = await mkdtemp(join(tmpdir(), "apt-opi-annotation-"));
	const capability = join(dir, "capabilities.json");
	const captured = await Bun.file(
		new URL("./fixtures/apt-opi-upgrade-20261014.stdout", import.meta.url),
	).text();
	const inventory = await Bun.file(
		new URL(
			"./fixtures/apt-opi-source-policy-20261014.stdout",
			import.meta.url,
		),
	).text();
	const commands: string[][] = [];
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
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	}));
	setAptCommandRunnerForTest(async (argv) => {
		commands.push([...argv]);
		if (argv[1] === "-s") return { exitCode: 0, stdout: captured, stderr: "" };
		if (argv[1] === "showhold")
			return {
				exitCode: 0,
				stdout: "linux-image-7.2.0-ceralive-rk3588\n",
				stderr: "",
			};
		if (argv[1] === "policy")
			return {
				exitCode: 0,
				stderr: "",
				stdout: argv[2]
					? `${argv[2]}:
  Installed: 8.14.1-2+deb13u5
  Candidate: 8.14.1-2+deb13u7
  Version table:
     8.14.1-2+deb13u7 500
        500 https://deb.debian.org/debian-security trixie-security/main arm64 Packages
`
					: inventory,
			};
		throw new Error(`unexpected APT command: ${JSON.stringify(argv)}`);
	});
	try {
		// When
		await runUpdateDiscoveryAndReport();
		// Then
		expect(getUpdateState()).toMatchObject({
			kind: "available",
			actionable_count: 3,
			packages: ["curl", "libcurl4t64", "libcurl3t64-gnutls"].map((name) => ({
				name,
				version: "8.14.1-2+deb13u7",
				origin: "Debian trixie-security",
				layer: "app",
				actionable: true,
			})),
		});
		expect(commands[0]).toEqual([
			"/usr/bin/apt-get",
			"-s",
			"-o",
			"Debug::NoLocking=1",
			"upgrade",
			"--with-new-pkgs",
		]);
		expect(commands.filter((argv) => argv[1] === "policy")).toEqual([
			["/usr/bin/apt-cache", "policy"],
			["/usr/bin/apt-cache", "policy", "curl"],
			["/usr/bin/apt-cache", "policy", "libcurl4t64"],
			["/usr/bin/apt-cache", "policy", "libcurl3t64-gnutls"],
		]);
	} finally {
		setAptCommandRunnerForTest(null);
		setUpdateCapabilityPathForTest(null);
		setCeraliveSourcesFileForTest(null);
		setUpdateSettingsFilePathForTest(null);
		resetAptReachabilityProbeForTest();
		resetSoftwareUpdateState();
		notificationRemove("ceralive_update_failed");
		await rm(dir, { recursive: true, force: true });
	}
});
