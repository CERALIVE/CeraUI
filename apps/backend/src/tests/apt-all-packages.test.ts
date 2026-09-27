import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateStateSchema } from "@ceraui/rpc";
import {
	assertPinnedInstallSimulation,
	buildAptAllInstallArgs,
	discoverAptAllPackages,
	parseAptSimulation,
} from "../modules/system/apt-all-packages.ts";
import { recoverDetachedAptUpgrade } from "../modules/system/software-update-process.ts";
import { buildDetachedAptAllCommand } from "../modules/system/software-update-service.ts";
import { validateDetachedAptServiceIdentity } from "../modules/system/software-update-service-contract.ts";
import {
	buildAptDiscoveryArgs,
	buildAptUpgradeArgs,
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
} from "../modules/system/software-updates.ts";
import {
	buildCeraliveSources,
	reconcileAptChannel,
	setCeraliveSourcesFileForTest,
} from "../modules/system/update-apt-channel.ts";
import {
	readUpdateCapabilities,
	setUpdateCapabilityPathForTest,
} from "../modules/system/update-capabilities.ts";

// Captured on rock-5b-plus, 2026-09-27, LC_ALL=C apt-cache policy <name>
// and apt-cache policy (unscoped). The foreign source below changes only the
// host and release metadata to exercise a repository the board does not carry.
const credentialPolicy = `ceralive-apt-credentials:
  Installed: 1.0.0
  Candidate: 1.0.1
  Version table:
     1.0.1 990
        500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages
 *** 1.0.0 990
        500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages
        100 /var/lib/dpkg/status
`;
const debianPolicy = `libc6:
  Installed: 2.41-12+deb13u4
  Candidate: 2.41-12+deb13u4
  Version table:
 *** 2.41-12+deb13u4 500
        500 https://deb.debian.org/debian trixie/main arm64 Packages
        100 /var/lib/dpkg/status
`;
const foreignPolicy = debianPolicy
	.replaceAll("libc6", "outsider")
	.replaceAll("2.41-12+deb13u4", "2")
	.replace(
		"deb.debian.org/debian trixie/main",
		"foreign.example/debian trixie/main",
	);
const policy = (name: string): string =>
	name === "ceralive-apt-credentials"
		? credentialPolicy
		: name === "libc6"
			? debianPolicy
			: foreignPolicy;
const sourcePolicy = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 https://deb.debian.org/debian trixie-updates/main arm64 Packages
     release v=13-updates,o=Debian,a=stable-updates,n=trixie-updates,l=Debian,c=main,b=arm64
     origin deb.debian.org
 500 https://deb.debian.org/debian-security trixie-security/main arm64 Packages
     release v=13,o=Debian,a=stable-security,n=trixie-security,l=Debian-Security,c=main,b=arm64
     origin deb.debian.org
 500 https://deb.debian.org/debian trixie/non-free-firmware arm64 Packages
     release v=13.7,o=Debian,a=stable,n=trixie,l=Debian,c=non-free-firmware,b=arm64
     origin deb.debian.org
 500 https://deb.debian.org/debian trixie/main arm64 Packages
     release v=13.7,o=Debian,a=stable,n=trixie,l=Debian,c=main,b=arm64
     origin deb.debian.org
 500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:
`;
const foreignSource = ` 500 https://foreign.example/debian trixie/main arm64 Packages
     release o=Other,a=stable,n=trixie,l=Other,c=main,b=arm64
     origin foreign.example
`;
const inventory = sourcePolicy.replace(
	"Pinned packages:",
	`${foreignSource}Pinned packages:`,
);
const simulation = `Inst ceralive-apt-credentials [1.0.0] (1.0.1 apt.ceralive.tv [arm64])\nInst libc6 [2.41] (2.41-12+deb13u4 Debian:13.0/stable [arm64])\nInst outsider [1] (2 other [arm64])\nConf ceralive-apt-credentials (1.0.1 apt.ceralive.tv [arm64])\n`;

describe("apt-all-packages admission", () => {
	it("parses simulation versions and refuses ANY removal", () => {
		expect(parseAptSimulation(simulation)).toEqual([
			{ name: "ceralive-apt-credentials", version: "1.0.1" },
			{ name: "libc6", version: "2.41-12+deb13u4" },
			{ name: "outsider", version: "2" },
		]);
		expect(() => parseAptSimulation(`${simulation}Remv libfoo [1]\n`)).toThrow(
			"removals_required",
		);
		assertPinnedInstallSimulation(
			"Inst ceralive-apt-credentials [1] (1.0.1 apt.ceralive.tv [arm64])\n",
			[{ name: "ceralive-apt-credentials", version: "1.0.1" }],
		);
		expect(() =>
			assertPinnedInstallSimulation(simulation, [
				{ name: "ceralive-apt-credentials", version: "1.0.1" },
			]),
		).toThrow("discovery_failed");
	});

	it("filters candidates by origin, excludes held names and pins exactly the actionable set", async () => {
		const seen: string[] = [];
		const result = await discoverAptAllPackages(
			simulation,
			"linux-image-7.2\n",
			async (name) => {
				seen.push(name);
				return policy(name);
			},
			inventory,
		);
		expect(seen).toEqual(["ceralive-apt-credentials", "libc6", "outsider"]);
		expect(result.actionable).toEqual([
			{ name: "ceralive-apt-credentials", version: "1.0.1" },
			{ name: "libc6", version: "2.41-12+deb13u4" },
		]);
		expect(
			result.packages.find((p) => p.name === "ceralive-apt-credentials"),
		).toMatchObject({
			origin: "apt.ceralive.tv",
			layer: "app",
			actionable: true,
		});
		expect(result.packages.find((p) => p.name === "libc6")).toMatchObject({
			origin: "Debian trixie",
			layer: "app",
			actionable: true,
		});
		expect(result.packages.find((p) => p.name === "outsider")?.actionable).toBe(
			false,
		);
		const parsed = updateStateSchema.parse({
			kind: "available",
			identity: { version: "fixture", packages: ["ceralive-apt-credentials"] },
			package_count: 1,
			packages: result.packages,
			actionable_count: 2,
		});
		expect(parsed.kind).toBe("available");
		if (parsed.kind === "available")
			expect(parsed.packages).toEqual(result.packages);
		expect(buildAptAllInstallArgs(result.actionable, "any")).toEqual([
			"-y",
			"--no-download",
			"--no-remove",
			"-o",
			"Dpkg::Options::=--force-confdef",
			"-o",
			"Dpkg::Options::=--force-confold",
			"install",
			"ceralive-apt-credentials=1.0.1",
			"libc6=2.41-12+deb13u4",
		]);
		expect(() =>
			buildAptAllInstallArgs(
				[{ name: "outsider", version: "2;reboot" }],
				"any",
			),
		).toThrow();
		const duplicated = credentialPolicy.replace(
			" *** 1.0.0",
			"        500 https://foreign.example/debian trixie/main arm64 Packages\n *** 1.0.0",
		);
		expect(
			(
				await discoverAptAllPackages(
					simulation,
					"",
					async (name) =>
						name === "ceralive-apt-credentials" ? duplicated : policy(name),
					inventory,
				)
			).actionable.map((p) => p.name),
		).toEqual(["libc6"]);
	});

	it("fails closed on spoofed, missing or conflicting source metadata and disallowed Debian suites", async () => {
		const onlyCredentials =
			"Inst ceralive-apt-credentials [1.0.0] (1.0.1 apt.ceralive.tv [arm64])\n";
		for (const sources of [
			"Package files:\nPinned packages:\n",
			sourcePolicy.replace("o=CeraLive", "o=Other"),
			sourcePolicy.replace("origin apt.ceralive.tv", "origin foreign.example"),
			sourcePolicy.replace(
				"Pinned packages:",
				` 500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages\n     release o=Other,n=stable,l=Other\n     origin apt.ceralive.tv\nPinned packages:`,
			),
		]) {
			expect(
				(
					await discoverAptAllPackages(
						onlyCredentials,
						"",
						async () => credentialPolicy,
						sources,
					)
				).actionable,
			).toEqual([]);
		}
		const onlyDebian =
			"Inst libc6 [2.41] (2.41-12+deb13u4 Debian:13.0/stable [arm64])\n";
		for (const sources of [
			sourcePolicy.replace(
				"n=trixie,l=Debian,c=main",
				"n=bookworm,l=Debian,c=main",
			),
			sourcePolicy.replace(
				"o=Debian,a=stable,n=trixie,l=Debian,c=main",
				"o=Other,a=stable,n=trixie,l=Debian,c=main",
			),
		]) {
			expect(
				(
					await discoverAptAllPackages(
						onlyDebian,
						"",
						async () => debianPolicy,
						sources,
					)
				).actionable,
			).toEqual([]);
		}
		const spoofed = inventory.replace(
			"o=Other,a=stable,n=trixie,l=Other",
			"o=Debian,a=stable,n=trixie,l=Debian",
		);
		expect(
			(
				await discoverAptAllPackages(
					"Inst outsider [1] (2 other [arm64])\n",
					"",
					async () => foreignPolicy,
					spoofed,
				)
			).actionable,
		).toEqual([]);
	});

	it("admits Debian updates and security only under their captured Release identities", async () => {
		const onlyDebian =
			"Inst libc6 [2.41] (2.41-12+deb13u4 Debian:13.0/stable [arm64])\n";
		for (const [suite, file] of [
			[
				"trixie-updates",
				"https://deb.debian.org/debian trixie-updates/main arm64 Packages",
			],
			[
				"trixie-security",
				"https://deb.debian.org/debian-security trixie-security/main arm64 Packages",
			],
		] as const) {
			const policy = debianPolicy.replace(
				"https://deb.debian.org/debian trixie/main arm64 Packages",
				file,
			);
			const result = await discoverAptAllPackages(
				onlyDebian,
				"",
				async () => policy,
				sourcePolicy,
			);
			expect(result.packages[0]).toMatchObject({
				origin: `Debian ${suite}`,
				layer: "app",
				actionable: true,
			});
		}
	});

	it("refuses the whole transaction when a first-party package is held", async () => {
		await expect(
			discoverAptAllPackages(
				simulation,
				"ceralive-apt-credentials\n",
				async (name) => policy(name),
				inventory,
			),
		).rejects.toThrow("first_party_held_back");
	});

	it("capability file selects the real discovery path; absent file keeps legacy argv and roster byte-identical", async () => {
		const dir = await mkdtemp(
			path.join(tmpdir(), "ceralive-capability-discovery-"),
		);
		const capability = path.join(dir, "capabilities.json");
		const source = path.join(dir, "ceralive.sources");
		const seen: string[][] = [];
		setUpdateCapabilityPathForTest(capability);
		setCeraliveSourcesFileForTest(source);
		setAptReachabilityProbeForTest(async () => ({
			ipv4: "ok",
			ipv6: "ok",
			used: "any",
			verdict: "any",
			detail: [],
		}));
		setAptCommandRunnerForTest(async (argv) => {
			seen.push([...argv]);
			const result =
				argv[1] === "-s"
					? simulation
					: argv[1] === "showhold"
						? "linux-image-7.2\n"
						: argv[1] === "policy"
							? argv[2]
								? policy(argv[2])
								: inventory
							: `The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nNeed to get 1 MB of archives.\n`;
			return { exitCode: 0, stdout: result, stderr: "" };
		});
		try {
			expect((await readUpdateCapabilities()).mode).toBe("legacy");
			expect(buildAptDiscoveryArgs("any")).toEqual([
				"/usr/bin/apt-get",
				"dist-upgrade",
				"--assume-no",
			]);
			expect(buildAptUpgradeArgs(["cerastream"], "any")).toEqual([
				"-y",
				"-o",
				"Dpkg::Options::=--force-confdef",
				"-o",
				"Dpkg::Options::=--force-confold",
				"install",
				"cerastream",
			]);
			await runUpdateDiscoveryAndReport();
			expect(seen[0]).toEqual(buildAptDiscoveryArgs("any"));
			expect(getUpdateState()).toMatchObject({
				kind: "available",
				actionable_count: 1,
			});
			expect(await Bun.file(source).exists()).toBe(false);
			resetSoftwareUpdateState();
			seen.length = 0;
			await writeFile(
				capability,
				JSON.stringify({
					schema: 1,
					features: ["apt-all-packages"],
					ota_uid: 42041,
					apt_uid: 42042,
				}),
			);
			await runUpdateDiscoveryAndReport();
			expect(seen[0]).toEqual([
				"/usr/bin/apt-get",
				"-s",
				"-o",
				"Debug::NoLocking=1",
				"upgrade",
				"--with-new-pkgs",
			]);
			expect(getUpdateState()).toMatchObject({
				kind: "available",
				actionable_count: 2,
			});
			expect(
				seen.filter((argv) => argv[1] === "policy" && argv.length === 2),
			).toHaveLength(1);
			expect(await readFile(source, "utf8")).toBe(
				buildCeraliveSources("stable", "amd64"),
			);
		} finally {
			setUpdateCapabilityPathForTest(null);
			setCeraliveSourcesFileForTest(null);
			setAptCommandRunnerForTest(null);
			resetAptReachabilityProbeForTest();
			resetSoftwareUpdateState();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("capable discovery refuses the entire transaction and publishes a typed notification reason", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "ceralive-apt-refusal-"));
		const capability = path.join(dir, "capabilities.json");
		await writeFile(
			capability,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages"],
				ota_uid: 42041,
				apt_uid: 42042,
			}),
		);
		setUpdateCapabilityPathForTest(capability);
		setCeraliveSourcesFileForTest(path.join(dir, "sources"));
		setAptReachabilityProbeForTest(async () => ({
			ipv4: "ok",
			ipv6: "ok",
			used: "any",
			verdict: "any",
			detail: [],
		}));
		let simulated = `${simulation}Remv libfoo [1]\n`;
		let holds = "";
		setAptCommandRunnerForTest(async (argv) => ({
			exitCode: 0,
			stderr: "",
			stdout:
				argv[1] === "-s"
					? simulated
					: argv[1] === "showhold"
						? holds
						: argv[2]
							? policy(argv[2])
							: inventory,
		}));
		try {
			await runUpdateDiscoveryAndReport();
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "removals_required",
			});
			resetSoftwareUpdateState();
			simulated = simulation;
			holds = "ceralive-apt-credentials\n";
			await runUpdateDiscoveryAndReport();
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "first_party_held_back",
			});
		} finally {
			setUpdateCapabilityPathForTest(null);
			setCeraliveSourcesFileForTest(null);
			setAptCommandRunnerForTest(null);
			resetAptReachabilityProbeForTest();
			resetSoftwareUpdateState();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("starts one detached wrapper: flock spans download then pinned install", () => {
		const args = buildAptAllInstallArgs(
			[{ name: "cerastream", version: "2026.9.7" }],
			"any",
		);
		const command = buildDetachedAptAllCommand(args, "any", {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		});
		expect(command.filter((token) => token === "systemd-run")).toHaveLength(1);
		expect(command).toContain("/usr/bin/flock");
		const script = command[command.length - 1] ?? "";
		expect(script).toContain("/usr/bin/apt-get -d -y upgrade --with-new-pkgs");
		expect(script).toContain(
			"/usr/bin/apt-get -y --no-download --no-remove -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install cerastream=2026.9.7",
		);
		expect(script.indexOf("upgrade --with-new-pkgs")).toBeLessThan(
			script.indexOf("install cerastream=2026.9.7"),
		);
		expect(script).not.toContain("; /usr/bin/apt-get");
		const state = (body: string) =>
			`Id=ceralive-software-update.service\nFragmentPath=/run/systemd/transient/ceralive-software-update.service\nDescription=CeraLive software update\nTransient=yes\nType=exec\nRemainAfterExit=yes\nStandardOutput=append\nStandardError=append\nUser=\nExecStartPre=\nExecStartPost=\nExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec '${body}' ; }\n`;
		expect(() =>
			validateDetachedAptServiceIdentity(state(script)),
		).not.toThrow();
		expect(() =>
			validateDetachedAptServiceIdentity(
				state(script).replace(
					"-x /run/lock/ceralive-update.lock",
					"-x /tmp/foreign",
				),
			),
		).toThrow();
		expect(() =>
			validateDetachedAptServiceIdentity(
				state(script.replace("install cerastream=", "upgrade cerastream=")),
			),
		).toThrow();
	});

	it("recovers the same unit after backend observer exits; the transaction and lock are not owned by the observer", async () => {
		let running = true;
		let starts = 0;
		let release = false;
		const recovered = await recoverDetachedAptUpgrade(
			{ onStdout: () => {}, onStderr: () => {} },
			{
				outputPaths: {
					stdout: "/run/ceralive/software-update.stdout",
					stderr: "/run/ceralive/software-update.stderr",
				},
				prepareOutput: async () => {},
				start: async () => {
					starts++;
				},
				inspect: async () =>
					running
						? { kind: "running" }
						: { kind: "finished", exitCode: 0, cleanup: "stop" },
				cleanup: async () => {
					release = true;
				},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async () => {
					expect(release).toBe(false);
					running = false;
				},
			},
		);
		expect(await recovered?.completion).toBe(0);
		expect(starts).toBe(0);
		expect(release).toBe(true);
	});

	it("a real wrapper process keeps its flock after a simulated backend exits and restarts", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "ceralive-flock-restart-"),
		);
		const lock = path.join(directory, "transaction.lock");
		const started = path.join(directory, "download-started");
		const committed = path.join(directory, "committed");
		const worker = Bun.spawn(
			[
				"/usr/bin/flock",
				"-x",
				lock,
				"/bin/sh",
				"-ec",
				`touch ${started}; sleep 0.4 && touch ${committed}`,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const probe = async () =>
			Bun.spawnSync(["/usr/bin/flock", "-n", lock, "/bin/true"]).exitCode;
		try {
			for (let i = 0; i < 30 && !(await Bun.file(started).exists()); i++)
				await Bun.sleep(10);
			expect(await Bun.file(started).exists()).toBe(true);
			const backend = Bun.spawn(["/bin/sh", "-ec", "exit 0"]);
			expect(await backend.exited).toBe(0);
			expect(await probe()).not.toBe(0);
			const restartedBackend = Bun.spawn(["/bin/sh", "-ec", "exit 0"]);
			expect(await restartedBackend.exited).toBe(0);
			expect(await probe()).not.toBe(0);
			expect(await worker.exited).toBe(0);
			expect(await Bun.file(committed).exists()).toBe(true);
			expect(await probe()).toBe(0);
		} finally {
			worker.kill();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("APT channel", () => {
	it("layers beta over stable, while stable has one stanza", () => {
		const stable = buildCeraliveSources("stable", "arm64");
		expect(stable).toContain(
			"URIs: https://apt.ceralive.tv/dists/stable/binary-arm64/",
		);
		expect(stable).not.toContain("/dists/beta/");
		expect(buildCeraliveSources("beta", "arm64")).toBe(
			`${stable}\n${stable.replace("/dists/stable/", "/dists/beta/")}`,
		);
	});
	it("reconciles once in capable mode and leaves legacy files untouched", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "ceralive-apt-channel-"),
		);
		const file = path.join(directory, "ceralive.sources");
		try {
			await writeFile(file, "legacy bytes");
			expect(await reconcileAptChannel("legacy", "beta", file, "arm64")).toBe(
				false,
			);
			expect(await readFile(file, "utf8")).toBe("legacy bytes");
			expect(await reconcileAptChannel("capable", "beta", file, "arm64")).toBe(
				true,
			);
			expect(
				await reconcileAptChannel("capable", "stable", file, "arm64"),
			).toBe(true);
			expect(await readFile(file, "utf8")).toBe(
				buildCeraliveSources("stable", "arm64"),
			);
			expect(
				buildAptAllInstallArgs(
					[{ name: "cerastream", version: "2026.9.7" }],
					"any",
				),
			).not.toContain("--allow-downgrades");
			const stableAfterBeta = await discoverAptAllPackages(
				"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
				"",
				async () => {
					throw new Error("no candidate must be resolved");
				},
				sourcePolicy,
			);
			expect(stableAfterBeta.actionable).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
