import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";

// APT's answers as a device gives them, for two modes. Capable discovery
// (`apt-get -s upgrade --with-new-pkgs`, holds, policies) offers ten CeraLive
// packages p1..p10 at version 2 over the installed 1, and the pinned recheck
// simulates exactly those pins; legacy discovery offers `cerastream`.
const SOURCE = "https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages";
const INVENTORY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${SOURCE}
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:
`;
const policy = (name: string) => `${name}:
  Installed: 1
  Candidate: 2
  Version table:
     2 990
        990 ${SOURCE}
 *** 1 100
        100 /var/lib/dpkg/status
`;
export const RESTART_PACKAGES = Array.from(
	{ length: 10 },
	(_, i) => `p${i + 1}`,
).sort();
const PLAN_LIST = `The following packages will be upgraded:\n  ${RESTART_PACKAGES.join(" ")}\n`;
const SUMMARY =
	"10 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
const SIMULATION =
	PLAN_LIST +
	SUMMARY +
	RESTART_PACKAGES.map(
		(name) => `Inst ${name} [1] (2 CeraLive:stable [arm64])\n`,
	).join("") +
	RESTART_PACKAGES.map(
		(name) => `Conf ${name} (2 CeraLive:stable [arm64])\n`,
	).join("");
const PREFETCH =
	PLAN_LIST +
	SUMMARY +
	RESTART_PACKAGES.map(
		(name, i) =>
			`Get:${i + 1} https://apt.ceralive.tv/dists/stable/binary-arm64 ./ ${name} 2 [4 kB]\n`,
	).join("") +
	"Fetched 40 kB in 0s (400 kB/s)\nDownload complete and in download only mode\n";
const LEGACY_PLAN = {
	exitCode: 1,
	stdout:
		"The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nNeed to get 4 kB of archives.\nDo you want to continue? [Y/n] N\nAbort.\n",
	stderr: "",
};
const ok = (stdout: string): SpawnWithTimeoutResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});

export async function scriptedApt(
	argv: readonly string[],
): Promise<SpawnWithTimeoutResult> {
	const [bin, verb, name] = argv;
	if (bin === "/usr/bin/apt-get" && verb === "update") return ok("");
	if (bin === "/usr/bin/apt-get" && verb === "dist-upgrade") return LEGACY_PLAN;
	if (bin === "/usr/bin/apt-get" && verb === "-s")
		return ok(
			argv.includes("cerastream")
				? "Inst cerastream [1] (2 stable [arm64])\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n"
				: SIMULATION,
		);
	if (bin === "/usr/bin/apt-get" && verb === "-d") return ok(PREFETCH);
	if (bin === "/usr/bin/apt-mark") return ok("");
	if (bin === "/usr/bin/apt-cache" && verb === "policy")
		return ok(name === undefined ? INVENTORY : policy(name));
	throw new Error(`unexpected APT command: ${JSON.stringify(argv)}`);
}
