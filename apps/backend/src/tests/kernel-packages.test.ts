import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SpawnTimeoutError,
	spawnWithTimeout,
} from "../helpers/spawn-policy.ts";
import { discoverAptAllPackages } from "../modules/system/apt-all-packages.ts";
import {
	downloadKernelPackage,
	kernelVersionGreater,
	parseKernelPackages,
	readAuthenticatedKernelPackages,
	selectKernelPackage,
	verifyKernelDownload,
} from "../modules/system/update-orchestrator/kernel-packages.ts";
import {
	kernelCapabilities,
	kernelRecord,
	packagesEntry,
} from "./helpers/kernel-update-fixture.ts";

test.each([
	["7.2.0-ceralive3", "linux-image-7.2.0-ceralive-rk3588"],
	["7.3.0-ceralive1", "linux-image-7.3.0-ceralive-rk3588"],
] as const)(
	"discovers %s independently of the frozen 1001 candidate",
	async (version, name) => {
		// Given signed-index records, not apt-cache's older frozen candidate.
		const higher = { ...kernelRecord, version, package: name };
		const records = parseKernelPackages(
			`${packagesEntry()}\n${packagesEntry(higher)}`,
		);
		// When selecting via real dpkg version order.
		const result = await selectKernelPackage(
			kernelCapabilities,
			records,
			{ ...kernelRecord, version: "7.2.0-ceralive1" },
			[],
		);
		// Then revision and package-name changes are both offered.
		expect(result).toEqual(higher);
	},
);
test("quarantine skips the exact failed version even if a conflicting digest is offered later", async () => {
	// Given a quarantined highest version and a healthy lower upgrade.
	const bad = {
		...kernelRecord,
		version: "7.2.0-ceralive10",
		deb_sha256: "b".repeat(64),
	};
	// When discovery uses the durable quarantine identities.
	const result = await selectKernelPackage(
		kernelCapabilities,
		[kernelRecord, bad],
		{ ...kernelRecord, version: "7.2.0-ceralive1" },
		[bad],
	);
	// Then it offers the non-quarantined upgrade, not the failed bytes.
	expect(result).toEqual(kernelRecord);
	expect(
		await kernelVersionGreater("7.2.0-ceralive10", "7.2.0-ceralive9"),
	).toBe(true);
});
test("kernel discovery is absent without capability", async () => {
	expect(
		await selectKernelPackage(
			{ mode: "legacy", features: [] },
			[kernelRecord],
			{ ...kernelRecord, version: "7.2.0-ceralive1" },
			[],
		),
	).toBeNull();
});
test("unsorted kernel records select the highest version rather than the first or last row", async () => {
	const highest = {
		...kernelRecord,
		package: "linux-image-7.3.0-ceralive-rk3588",
		version: "7.3.0-ceralive1",
	};
	const middle = { ...kernelRecord, version: "7.2.0-ceralive10" };
	const records = parseKernelPackages(
		[kernelRecord, highest, middle]
			.map((record) => packagesEntry(record))
			.join("\n"),
	);
	expect(
		await selectKernelPackage(
			kernelCapabilities,
			records,
			{ ...kernelRecord, version: "7.2.0-ceralive1" },
			[],
		),
	).toEqual(highest);
});
test.each([
	["equal", "7.2.0-ceralive2"],
	["older", "7.2.0-ceralive1"],
])(
	"kernel discovery offers nothing at the %s version boundary",
	async (_boundary, version) => {
		const records = parseKernelPackages(
			packagesEntry({ ...kernelRecord, version }),
		);
		expect(
			await selectKernelPackage(kernelCapabilities, records, kernelRecord, []),
		).toBeNull();
	},
);
test.each([
	"Version: invalid",
	"Size: -1",
	"SHA256: wrong",
	"Filename: ../../bad.deb",
	"Architecture: amd64",
	"Version: 7.2.0-ceralive2\nversion: 7.2.0-ceralive3",
])("refuses malformed Packages authority %s", (line) => {
	const field = line.split(":")[0];
	const text = packagesEntry()
		.split("\n")
		.filter((row) => !row.startsWith(`${field}:`))
		.join("\n");
	expect(() => parseKernelPackages(`${text}${line}\n`)).toThrow(
		"kernel_discovery_failed",
	);
});
test("reads only authenticated CeraLive source-list index bytes", async () => {
	const seen: string[][] = [];
	const index =
		"Identifier: Packages\nTrusted: yes\nOrigin: CeraLive\nLabel: CeraLive\nURI: https://apt.ceralive.tv/dists/stable/binary-arm64/./Packages\nFilename: /var/lib/apt/lists/apt_Packages.lz4\n";
	const run = async (argv: string[]) => {
		seen.push(argv);
		return {
			exitCode: 0,
			stdout: argv.includes("indextargets") ? index : packagesEntry(),
			stderr: "",
		};
	};
	expect(await readAuthenticatedKernelPackages(run)).toEqual([kernelRecord]);
	expect(seen).toEqual([
		[
			"/usr/bin/apt-get",
			"-o",
			"Dir::Etc::SourceList=/etc/apt/sources.list.d/ceralive.sources",
			"-o",
			"Dir::Etc::SourceParts=/dev/null",
			"indextargets",
			"Identifier: Packages",
		],
		[
			"/usr/lib/apt/apt-helper",
			"cat-file",
			"/var/lib/apt/lists/apt_Packages.lz4",
		],
	]);
	await expect(
		readAuthenticatedKernelPackages(async () => ({
			exitCode: 0,
			stdout: index.replace("Trusted: yes", "Trusted: no"),
			stderr: "",
		})),
	).rejects.toThrow("kernel_origin_mismatch");
});
test("same package/version from another origin cannot supply different bytes", async () => {
	// Given a selected CeraLive digest and foreign bytes with identical control identity.
	const directory = await mkdtemp(join(tmpdir(), "kernel-origin-"));
	const file = join(directory, "kernel.deb");
	await writeFile(file, "ours");
	const record = {
		...kernelRecord,
		deb_sha256: createHash("sha256").update("ours").digest("hex"),
	};
	const control = async () => ({
		exitCode: 0,
		stdout: `Package: ${record.package}\nVersion: ${record.version}\nArchitecture: arm64\n`,
		stderr: "",
	});
	try {
		// When the actual verifier sees ours, then different bytes for the same identity.
		await verifyKernelDownload(file, record, control);
		await writeFile(file, "evil");
		await expect(verifyKernelDownload(file, record, control)).rejects.toThrow(
			"kernel_origin_mismatch",
		);
		await writeFile(file, "ours");
		await expect(
			verifyKernelDownload(file, { ...record, size: 5 }, control),
		).rejects.toThrow("kernel_origin_mismatch");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test.each([
	["Package", "linux-image-7.3.0-ceralive-rk3588"],
	["Version", "7.2.0-ceralive3"],
	["Architecture", "amd64"],
])(
	"download refuses a mismatched %s control field with matching size and SHA256",
	async (field, value) => {
		const directory = await mkdtemp(join(tmpdir(), "kernel-control-"));
		const file = join(directory, "kernel.deb");
		await writeFile(file, "ours");
		const record = {
			...kernelRecord,
			deb_sha256: createHash("sha256").update("ours").digest("hex"),
		};
		const control = {
			Package: record.package,
			Version: record.version,
			Architecture: "arm64",
			[field]: value,
		};
		let controlsRead = 0;
		try {
			await expect(
				verifyKernelDownload(file, record, async () => {
					controlsRead++;
					return {
						exitCode: 0,
						stdout: Object.entries(control)
							.map(([key, entry]) => `${key}: ${entry}\n`)
							.join(""),
						stderr: "",
					};
				}),
			).rejects.toThrow("kernel_origin_mismatch");
			expect(controlsRead).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
test.each(["size", "SHA256"])(
	"download refuses a mismatched %s independently of valid control identity",
	async (field) => {
		const directory = await mkdtemp(join(tmpdir(), "kernel-archive-axis-"));
		const file = join(directory, "kernel.deb");
		await writeFile(file, "ours");
		const valid = {
			...kernelRecord,
			deb_sha256: createHash("sha256").update("ours").digest("hex"),
		};
		const record =
			field === "size"
				? { ...valid, size: 5 }
				: { ...valid, deb_sha256: "0".repeat(64) };
		let controlsRead = 0;
		try {
			await expect(
				verifyKernelDownload(file, record, async () => {
					controlsRead++;
					return {
						exitCode: 0,
						stdout: `Package: ${valid.package}\nVersion: ${valid.version}\nArchitecture: arm64\n`,
						stderr: "",
					};
				}),
			).rejects.toThrow("kernel_origin_mismatch");
			expect(controlsRead).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
test("download uses only the source list as the declared APT UID without changing holds", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-download-"));
	const seen: string[][] = [];
	const record = {
		...kernelRecord,
		deb_sha256: createHash("sha256").update("ours").digest("hex"),
	};
	try {
		await downloadKernelPackage(
			record,
			process.getuid?.() ?? 1000,
			directory,
			new AbortController().signal,
			async (argv) => {
				seen.push(argv);
				if (argv[0] === "setpriv")
					await writeFile(join(directory, "kernel.deb"), "ours");
				return {
					exitCode: 0,
					stdout:
						argv[0] === "dpkg-deb"
							? `Package: ${record.package}\nVersion: ${record.version}\nArchitecture: arm64\n`
							: "",
					stderr: "",
				};
			},
		);
		const uid = process.getuid?.() ?? 1000;
		expect(seen[0]).toEqual([
			"setpriv",
			`--reuid=${uid}`,
			`--regid=${uid}`,
			"--clear-groups",
			"/usr/bin/env",
			`--chdir=${directory}`,
			"/usr/bin/apt-get",
			"-o",
			"Dir::Etc::SourceList=/etc/apt/sources.list.d/ceralive.sources",
			"-o",
			"Dir::Etc::SourceParts=/dev/null",
			"download",
			`${record.package}=${record.version}`,
		]);
		expect(
			seen.some((argv) => argv.includes("unhold") || argv.includes("install")),
		).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("apt-all still excludes the held running kernel", async () => {
	const name = kernelRecord.package;
	const source =
		"Package files:\n 500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages\n     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=\n     origin apt.ceralive.tv\n";
	const result = await discoverAptAllPackages(
		`Inst ${name} (${kernelRecord.version} CeraLive [arm64])\n`,
		`${name}\n`,
		async () =>
			`Candidate: ${kernelRecord.version}\nVersion table:\n ${kernelRecord.version} 1001\n  500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages\n`,
		source,
	);
	expect(result.actionable).toEqual([]);
	expect(result.packages[0]?.actionable).toBe(false);
});
test("a hung download is bounded and cannot turn termination into success", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-hung-"));
	let deadline = 0;
	try {
		await expect(
			downloadKernelPackage(
				kernelRecord,
				process.getuid?.() ?? 1000,
				directory,
				new AbortController().signal,
				async (_argv, options) => {
					deadline = options?.timeoutMs ?? 0;
					return spawnWithTimeout(
						[
							process.execPath,
							"-e",
							"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
						],
						{
							...options,
							scheduleTimeout: (callback, ms) => {
								if (ms === 300_000) {
									queueMicrotask(callback);
									return 0;
								}
								return setTimeout(callback, ms);
							},
							cancelTimeout: (timer) => clearTimeout(timer),
						},
					);
				},
			),
		).rejects.toBeInstanceOf(SpawnTimeoutError);
		expect(deadline).toBe(300_000);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
