import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";

// Scripted APT answers for the CeraLive update notice tests: one package set
// drives legacy dist-upgrade, the install-plan and upgrade simulations, the
// source inventory and per-package policy, as a real device would answer.
export type AptPackage = {
	readonly name: string;
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
	// The state the device moves to once the evidence snapshot starts being read.
	readonly thenState?: AptScript;
};

// The restart-test backend child prints these on stdout.
export const READY_PREFIX = "backend:ready:";
export const CHECKED_MARKER = "backend:checked";
export const HYDRATED_MARKER = "backend:hydrated";
export const APPLIED_MARKER = "backend:apt-applied";
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

function policy(pkg: AptPackage): string {
	const source = pkg.source === "debian" ? DEBIAN_SOURCE : CERALIVE_SOURCE;
	const pin = pkg.pin ?? 990;
	return `${pkg.name}:\n  Installed: ${pkg.installed}\n  Candidate: ${pkg.candidate}\n  Version table:\n     ${pkg.candidate} ${pin}\n        ${pin} ${source}\n *** ${pkg.installed} 100\n        100 /var/lib/dpkg/status\n`;
}

function simulation(packages: readonly AptPackage[]): string {
	const rows = packages.map(
		(pkg) =>
			`Inst ${pkg.name} [${pkg.installed}] (${pkg.planned ?? pkg.candidate} stable [arm64])\n`,
	);
	return `${rows.join("")}${packages.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`;
}

function upgradePlan(packages: readonly AptPackage[]): SpawnWithTimeoutResult {
	if (packages.length === 0) return ok(NOTHING);
	const names = packages.map(({ name }) => name).join(" ");
	return {
		exitCode: 1,
		stdout: `The following packages will be upgraded:\n  ${names}\n${packages.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nNeed to get 4 kB of archives.\nDo you want to continue? [Y/n] N\nAbort.\n`,
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
		return answer(script)(argv);
	};
}

function answer(script: AptScript) {
	const upgradable = script.upgradable ?? [];
	const keptBack = script.keptBack ?? [];
	const all = [...upgradable, ...keptBack];
	const present = [...all, ...(script.installed ?? [])];
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
			const requested =
				install < 0
					? upgradable
					: all.filter((pkg) => argv.slice(install + 1).includes(pkg.name));
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
			const known = present.filter((pkg) => wanted.includes(pkg.name));
			const rows = known.map(
				(pkg) =>
					`${pkg.name}\t${script.holds?.includes(pkg.name) ? "hold" : "install"} ok installed\t${pkg.installed}\n`,
			);
			return {
				exitCode: known.length < wanted.length ? 1 : 0,
				stdout: rows.join(""),
				stderr: "",
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
