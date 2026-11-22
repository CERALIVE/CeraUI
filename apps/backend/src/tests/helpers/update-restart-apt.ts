import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";

// APT's answers for one pending CeraLive package, as a device gives them
// (command shapes as in PR #670's scripted APT).
const SOURCE = "https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages";
const INVENTORY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${SOURCE}
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:
`;
const POLICY = `cerastream:
  Installed: 1
  Candidate: 2
  Version table:
     2 990
        990 ${SOURCE}
 *** 1 100
        100 /var/lib/dpkg/status
`;
const PLAN = {
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
	if (bin === "/usr/bin/apt-get" && verb === "dist-upgrade") return PLAN;
	if (bin === "/usr/bin/apt-get" && verb === "-s")
		return ok(
			"Inst cerastream [1] (2 stable [arm64])\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
		);
	if (bin === "/usr/bin/apt-mark") return ok("");
	if (bin === "/usr/bin/apt-cache" && verb === "policy")
		return ok(name === undefined ? INVENTORY : POLICY);
	throw new Error(`unexpected APT command: ${JSON.stringify(argv)}`);
}
