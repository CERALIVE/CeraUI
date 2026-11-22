import { SpawnTimeoutError } from "../../helpers/bounded-spawn.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";

// Scripted APT answers for the CeraLive update notice tests: one package set
// drives legacy dist-upgrade, the install-plan and upgrade simulations, the
// source inventory and per-package policy, as a real device would answer.
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
};

export type AptScript = {
	readonly refresh?: Partial<SpawnWithTimeoutResult>;
	readonly upgradable?: readonly AptPackage[];
	readonly keptBack?: readonly AptPackage[];
	readonly discovery?: Partial<SpawnWithTimeoutResult>;
	readonly policyFails?: readonly string[];
	readonly planOmits?: readonly string[];
	readonly inventory?: string;
	// Installed with nothing pending (candidate equals installed).
	readonly installed?: readonly AptPackage[];
	// Names `apt-mark showhold` lists (dpkg then shows them as "hold ok installed").
	readonly holds?: readonly string[];
	// Known to APT with a candidate, not installed and not planned.
	readonly available?: readonly AptPackage[];
	// How one command fails instead of answering (see FailedRead).
	readonly fail?: Partial<Record<AptRead, FailedRead>>;
	// The state the device moves to once the roster policy is first read.
	readonly thenState?: AptScript;
};

export type AptRead =
	| "dpkg-query"
	| "apt-mark"
	| "roster-policy"
	| "inventory"
	| "simulation";
// How the command runner reports a child that never answered: a failed launch and a
// timeout throw (runAptCommand turns both into exit 1 with a diagnostic), a signal
// ends it with 128+n and partial output, a silent exit 1 says nothing at all, and a
// truncated answer exits 0 with only its first line.
export type FailedRead =
	| "launch"
	| "timeout"
	| "signal"
	| "silent-exit-1"
	| "truncated";

// The restart-test backend child prints these on stdout.
export const READY_PREFIX = "backend:ready:";
export const CHECKED_MARKER = "backend:checked";
export const HYDRATED_MARKER = "backend:hydrated";
export const APPLIED_MARKER = "backend:apt-applied";
// One per replay (a login, or startup), printed after its frames: `<prefix>sent|declined`.
export const REPLAY_PREFIX = "backend:replay:";
export const BLOCK_SET_MARKER = "backend:block-set";
// The blocked command has started (its answer is fixed by the state at that moment).
export const BLOCKED_MARKER = "backend:apt-blocked";
export const RELEASED_MARKER = "backend:apt-released";
export const SESSION_PASSWORD = "ceralive-session-password";
// Exit status of a session ended by the finished update's own restart (an uncaught throw).
export const RESTART_EXIT_CODE = 75;
// Printed only when the process ends through exactly that restart.
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
// CeraLive's source disabled or absent: the refresh only ever saw Debian.
export const DEBIAN_ONLY_INVENTORY = `${INVENTORY.split(` 500 ${CERALIVE_SOURCE}`)[0]}Pinned packages:\n`;
const NOTHING =
	"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";

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

function simulation(packages: readonly AptPackage[]): string {
	const rows = packages.map(
		(pkg) =>
			`Inst ${pkg.name}${isInstalled(pkg) ? ` [${pkg.installed}]` : ""} (${pkg.planned ?? pkg.candidate} stable [arm64])\n`,
	);
	return `${rows.join("")}${counts(packages)}`;
}

function upgradePlan(packages: readonly AptPackage[]): SpawnWithTimeoutResult {
	if (packages.length === 0) return ok(NOTHING);
	const list = (heading: string, rows: readonly AptPackage[]) =>
		rows.length === 0
			? ""
			: `${heading}\n  ${rows.map(({ name }) => name).join(" ")}\n`;
	return {
		exitCode: 1,
		stdout: `${list(
			"The following NEW packages will be installed:",
			packages.filter((pkg) => !isInstalled(pkg)),
		)}${list("The following packages will be upgraded:", packages.filter(isInstalled))}${counts(packages)}Need to get 4 kB of archives.\nDo you want to continue? [Y/n] N\nAbort.\n`,
		stderr: "",
	};
}

export function scriptedApt(initial: AptScript) {
	let script = initial;
	return async (argv: readonly string[]): Promise<SpawnWithTimeoutResult> => {
		if (
			script.thenState &&
			argv[0] === "/usr/bin/apt-cache" &&
			argv[1] === "policy" &&
			argv.length > 3
		)
			script = script.thenState;
		const failure = script.fail?.[readOf(argv)];
		return failure === undefined
			? answer(script)(argv)
			: failed(failure, argv, await answer(script)(argv));
	};
}

function readOf(argv: readonly string[]): AptRead {
	if (argv[0] === "/usr/bin/dpkg-query") return "dpkg-query";
	if (argv[0] === "/usr/bin/apt-mark") return "apt-mark";
	if (argv[0] === "/usr/bin/apt-cache")
		return argv.length > 3 ? "roster-policy" : "inventory";
	return "simulation";
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
			return { ...ok(""), ...script.refresh };
		if (bin === "/usr/bin/apt-get" && verb === "dist-upgrade") {
			const plan = upgradePlan(upgradable);
			if (keptBack.length === 0) return { ...plan, ...script.discovery };
			const held = keptBack.map((pkg) => pkg.name).join(" ");
			return {
				...plan,
				stdout: `The following packages have been kept back:\n  ${held}\n${plan.stdout}`,
				...script.discovery,
			};
		}
		if (bin === "/usr/bin/apt-get" && verb === "install")
			return upgradePlan(keptBack);
		if (bin === "/usr/bin/apt-get" && verb === "-s") {
			const install = argv.indexOf("install");
			// An explicit install also takes the new packages the plan depends on.
			const requested =
				install < 0
					? upgradable
					: all.filter(
							(pkg) =>
								argv.slice(install + 1).includes(pkg.name) || !isInstalled(pkg),
						);
			return ok(
				simulation(
					requested.filter((pkg) => !script.planOmits?.includes(pkg.name)),
				),
			);
		}
		if (bin === "/usr/bin/apt-mark")
			return ok((script.holds ?? []).map((name) => `${name}\n`).join(""));
		if (bin === "/usr/bin/dpkg-query") {
			const wanted = argv.slice(4);
			const known = present.filter(
				(pkg) => isInstalled(pkg) && wanted.includes(pkg.name),
			);
			const rows = known.map(
				(pkg) =>
					`${pkg.name}\t${script.holds?.includes(pkg.name) ? "hold" : "install"} ok installed\t${pkg.installed}\n`,
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
		if (bin === "/usr/bin/apt-cache" && verb === "policy") {
			if (name === undefined) return ok(script.inventory ?? INVENTORY);
			if (script.policyFails?.includes(name))
				return { exitCode: 100, stdout: "", stderr: `E: ${name}\n` };
			// Several names: one block per known package, as APT prints them.
			if (argv.length > 3)
				return ok(
					argv
						.slice(2)
						.flatMap((wanted) => present.filter((pkg) => pkg.name === wanted))
						.map(policy)
						.join(""),
				);
			const pkg = present.find((candidate) => candidate.name === name);
			if (pkg) return ok(policy(pkg));
		}
		throw new Error(`unexpected APT command: ${JSON.stringify(argv)}`);
	};
}
