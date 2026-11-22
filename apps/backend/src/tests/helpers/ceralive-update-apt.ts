import { SpawnTimeoutError } from "../../helpers/bounded-spawn.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";

// Scripted APT answers for the CeraLive update notice tests: one package set
// drives legacy dist-upgrade, the capable upgrade simulation, the source
// inventory, per-package policy and record, and dpkg's installed instances, as a
// real device would answer. Version comparison is the host's own dpkg.
export type AptPackage = {
	readonly name: string;
	// "(none)" for a package that is not installed (a new install when planned).
	readonly installed: string;
	readonly candidate: string;
	// The version the simulated plan takes, when it differs from the candidate.
	readonly planned?: string;
	readonly source?: "ceralive" | "debian";
	// The candidate's priority in the policy version table.
	readonly pin?: number;
	// The candidate's own architecture (default arm64).
	readonly arch?: string;
	// The installed instance's architecture in dpkg, when it differs from the candidate's.
	readonly installedArch?: string;
};

export type AptScript = {
	readonly refresh?: Partial<SpawnWithTimeoutResult>;
	readonly upgradable?: readonly AptPackage[];
	readonly keptBack?: readonly AptPackage[];
	readonly discovery?: Partial<SpawnWithTimeoutResult>;
	readonly policyFails?: readonly string[];
	readonly inventory?: string;
	// Installed with nothing pending (candidate equals installed).
	readonly installed?: readonly AptPackage[];
	// Names `apt-mark showhold` lists (dpkg then shows them held: `hi `).
	readonly holds?: readonly string[];
	// Known to APT with a candidate, not installed and not planned.
	readonly available?: readonly AptPackage[];
	// dpkg's db:Status-Abbrev for a package, instead of the `ii ` its state implies.
	readonly dpkgStatus?: Readonly<Record<string, string>>;
	// How one command fails instead of answering (see FailedRead).
	readonly fail?: Partial<Record<AptRead, FailedRead>>;
};

export type AptRead =
	| "refresh"
	| "discovery"
	| "simulation"
	| "inventory"
	| "package-policy"
	| "package-record"
	| "apt-mark"
	| "dpkg-query"
	| "dpkg-compare";
// How the command runner reports a child that never answered: a failed launch and a
// timeout throw (runAptCommand turns both into exit 1 with a diagnostic), a signal
// ends it with 128+n and partial output, a silent exit 1 says nothing at all. An
// answer can also exit 0 incompletely: only its first line (truncated), without its
// summary line (no-summary), or cut right after it (cut-after-summary).
export type FailedRead =
	| "launch"
	| "timeout"
	| "signal"
	| "silent-exit-1"
	| "truncated"
	| "no-summary"
	| "cut-after-summary";

// The restart-test backend child prints these on stdout.
export const READY_PREFIX = "backend:ready:";
export const CHECKED_MARKER = "backend:checked";
export const HYDRATED_MARKER = "backend:hydrated";
export const APPLIED_MARKER = "backend:apt-applied";
// One per login, printed after its frames: `<prefix>sent|declined`.
export const REPLAY_PREFIX = "backend:replay:";
export const SESSION_PASSWORD = "ceralive-session-password";
// Exit status of a session ended by the finished update's own restart (an uncaught throw).
export const RESTART_EXIT_CODE = 75;
// Printed when the process reaches exactly that restart (held until `exit`).
export const RECOVERY_RESTART_MARKER = "recovery:restart";
// Printed when recovery ends the process any other way.
export const RECOVERY_FAILED_MARKER = "recovery:failed";

export const CERALIVE_SOURCE =
	"https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages";
const DEBIAN_SOURCE =
	"https://deb.debian.org/debian-security trixie-security/main arm64 Packages";
export const INVENTORY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${DEBIAN_SOURCE}
     release v=13,o=Debian,a=stable-security,n=trixie-security,l=Debian-Security,c=main,b=arm64
     origin deb.debian.org
 500 ${CERALIVE_SOURCE}
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:
`;
const REFRESH = `Hit:1 https://deb.debian.org/debian-security trixie-security InRelease
Hit:2 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ InRelease
Reading package lists...
`;
// CeraLive's source disabled or absent: the inventory lists only Debian.
export const DEBIAN_ONLY_INVENTORY = `${INVENTORY.split(` 500 ${CERALIVE_SOURCE}`)[0]}Pinned packages:\n`;
const NOTHING =
	"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
// What apt-get prints before its plan when it is not quiet.
const PREAMBLE =
	"Reading package lists...\nBuilding dependency tree...\nReading state information...\n";
const SUMMARY = /^\d+ upgraded, /;

function ok(stdout: string): SpawnWithTimeoutResult {
	return { exitCode: 0, stdout, stderr: "" };
}

const NONE = "(none)";
const isInstalled = (pkg: AptPackage) => pkg.installed !== NONE;

function policy(pkg: AptPackage): string {
	const source = pkg.source === "debian" ? DEBIAN_SOURCE : CERALIVE_SOURCE;
	const pin = pkg.pin ?? 990;
	const local = isInstalled(pkg)
		? ` *** ${pkg.installed} 100\n        100 /var/lib/dpkg/status\n`
		: "";
	return `${pkg.name}:\n  Installed: ${pkg.installed}\n  Candidate: ${pkg.candidate}\n  Version table:\n     ${pkg.candidate} ${pin}\n        ${pin} ${source}\n${local}`;
}

function counts(packages: readonly AptPackage[]): string {
	const upgraded = packages.filter(isInstalled).length;
	return `${upgraded} upgraded, ${packages.length - upgraded} newly installed, 0 to remove and 0 not upgraded.\n`;
}

// APT's order: the summary comes before the Inst rows it counts.
function simulation(packages: readonly AptPackage[]): string {
	const rows = packages.map(
		(pkg) =>
			`Inst ${pkg.name}${isInstalled(pkg) ? ` [${pkg.installed}]` : ""} (${pkg.planned ?? pkg.candidate} stable [${pkg.arch ?? "arm64"}])\n`,
	);
	return `${PREAMBLE}${counts(packages)}${rows.join("")}`;
}

// What --assume-no discovery prints before its lists and summary.
const CALCULATING = `${PREAMBLE}Calculating upgrade...\n`;

function upgradePlan(packages: readonly AptPackage[]): SpawnWithTimeoutResult {
	if (packages.length === 0) return ok(`${CALCULATING}${NOTHING}`);
	const list = (heading: string, rows: readonly AptPackage[]) =>
		rows.length === 0
			? ""
			: `${heading}\n  ${rows.map(({ name }) => name).join(" ")}\n`;
	return {
		exitCode: 1,
		stdout: `${CALCULATING}${list(
			"The following NEW packages will be installed:",
			packages.filter((pkg) => !isInstalled(pkg)),
		)}${list("The following packages will be upgraded:", packages.filter(isInstalled))}${counts(packages)}Need to get 4 kB of archives.\nDo you want to continue? [Y/n] N\nAbort.\n`,
		stderr: "",
	};
}

export function scriptedApt(script: AptScript) {
	return async (argv: readonly string[]): Promise<SpawnWithTimeoutResult> => {
		const failure = script.fail?.[readOf(argv)];
		return failure === undefined
			? answer(script)(argv)
			: failed(failure, argv, await answer(script)(argv));
	};
}

function readOf(argv: readonly string[]): AptRead {
	const [bin, verb] = argv;
	if (bin === "dpkg-query") return "dpkg-query";
	if (bin === "dpkg") return "dpkg-compare";
	if (bin === "/usr/bin/apt-mark") return "apt-mark";
	if (bin === "/usr/bin/apt-cache")
		return argv.length === 2
			? "inventory"
			: verb === "show"
				? "package-record"
				: "package-policy";
	if (verb === "update") return "refresh";
	return verb === "-s" ? "simulation" : "discovery";
}

function failed(
	how: FailedRead,
	argv: readonly string[],
	would: SpawnWithTimeoutResult,
): SpawnWithTimeoutResult {
	const partial = would.stdout.split("\n")[0] ?? "";
	if (how === "launch")
		throw Object.assign(
			new Error(`ENOENT: no such file or directory, posix_spawn '${argv[0]}'`),
			{ code: "ENOENT" },
		);
	if (how === "timeout") throw new SpawnTimeoutError(argv.join(" "), partial);
	if (how === "signal") return { exitCode: 137, stdout: partial, stderr: "" };
	if (how === "truncated")
		return { exitCode: 0, stdout: `${partial}\n`, stderr: "" };
	const lines = would.stdout.split("\n");
	if (how === "no-summary")
		return {
			...would,
			stdout: lines.filter((line) => !SUMMARY.test(line)).join("\n"),
		};
	if (how === "cut-after-summary") {
		const end = lines.findIndex((line) => SUMMARY.test(line));
		return { ...would, stdout: `${lines.slice(0, end + 1).join("\n")}\n` };
	}
	return { exitCode: 1, stdout: "", stderr: "" };
}

function answer(script: AptScript) {
	const upgradable = script.upgradable ?? [];
	const keptBack = script.keptBack ?? [];
	const all = [...upgradable, ...keptBack];
	const present = [
		...all,
		...(script.installed ?? []),
		...(script.available ?? []),
	];
	return async (argv: readonly string[]): Promise<SpawnWithTimeoutResult> => {
		const [bin, verb] = argv;
		const name = argv[2];
		if (bin === "/usr/bin/apt-get" && verb === "update")
			return { ...ok(REFRESH), ...script.refresh };
		if (bin === "/usr/bin/apt-get" && verb === "dist-upgrade") {
			const plan = upgradePlan(upgradable);
			if (keptBack.length === 0) return { ...plan, ...script.discovery };
			const held = keptBack.map((pkg) => pkg.name).join(" ");
			return {
				...plan,
				stdout: `${CALCULATING}The following packages have been kept back:\n  ${held}\n${plan.stdout.slice(CALCULATING.length)}`,
				...script.discovery,
			};
		}
		if (bin === "/usr/bin/apt-get" && verb === "install")
			return upgradePlan(keptBack);
		if (bin === "/usr/bin/apt-get" && verb === "-s")
			return ok(simulation(upgradable));
		if (bin === "/usr/bin/apt-mark")
			return ok((script.holds ?? []).map((name) => `${name}\n`).join(""));
		// What #664's readback asks: `dpkg-query -W -f=<format> -- <names>`.
		if (bin === "dpkg-query") {
			const wanted = argv.slice(argv.indexOf("--") + 1);
			const known = present.filter(
				(pkg) => isInstalled(pkg) && wanted.includes(pkg.name),
			);
			const rows = known.map(
				(pkg) =>
					`${pkg.name}\t${pkg.installedArch ?? pkg.arch ?? "arm64"}\t${script.dpkgStatus?.[pkg.name] ?? (script.holds?.includes(pkg.name) ? "hi " : "ii ")}\t${pkg.installed}\n`,
			);
			const absent = wanted.filter(
				(name) => !known.some((pkg) => pkg.name === name),
			);
			// dpkg-query exits 1 and names each package it does not know on stderr.
			return {
				exitCode: absent.length > 0 ? 1 : 0,
				stdout: rows.join(""),
				stderr: absent
					.map((name) => `dpkg-query: no packages found matching ${name}\n`)
					.join(""),
			};
		}
		if (bin === "dpkg" && verb === "--compare-versions") {
			const compared = Bun.spawnSync(["dpkg", ...argv.slice(1)]);
			return { exitCode: compared.exitCode ?? 2, stdout: "", stderr: "" };
		}
		if (bin === "/usr/bin/apt-cache" && verb === "show") {
			const pkg = present.find((candidate) => candidate.name === argv[3]);
			if (pkg)
				return ok(
					`Package: ${pkg.name}\nArchitecture: ${pkg.arch ?? "arm64"}\nVersion: ${pkg.candidate}\nPriority: optional\n\n`,
				);
		}
		if (bin === "/usr/bin/apt-cache" && verb === "policy") {
			if (name === undefined) return ok(script.inventory ?? INVENTORY);
			if (script.policyFails?.includes(name))
				return { exitCode: 100, stdout: "", stderr: `E: ${name}\n` };
			const pkg = present.find((candidate) => candidate.name === name);
			if (pkg) return ok(policy(pkg));
		}
		throw new Error(`unexpected APT command: ${JSON.stringify(argv)}`);
	};
}
