import type { UpdateProgress } from "@ceraui/rpc/schemas";

export type SoftUpdateStatus = Omit<UpdateProgress, "result"> & {
	result?: string | 0;
};

type Phase = "preparing" | "downloading" | "installing";

// The step fields are phase markers: update-state reads a nonzero
// unpacking/setting_up as "installing", and total stays at 1 so an older
// release's page cannot compute a full bar from them.
export const PHASE_MARKERS = {
	preparing: { total: 0, downloading: 0, unpacking: 0, setting_up: 0 },
	downloading: { total: 1, downloading: 1, unpacking: 0, setting_up: 0 },
	installing: { total: 1, downloading: 0, unpacking: 0, setting_up: 1 },
} as const;

// Progress comes only from the unit's own stdout file: APT is given no
// telemetry descriptor, so nothing that reads progress can block or fail it.
// Only whole lines in APT's and dpkg's own shape (the unit runs in the C
// locale) count, each package step once: a script or hook line that quotes
// them is not work. apt-get prints its plan before acting and "Get:<n>" as it
// STARTS each archive (several at once, and nothing when one is done), so a
// download shows its phase only: no line proves a share of it complete. dpkg
// prints "Unpacking" and "Setting up" as it starts each package's two steps,
// one at a time, so a step counts as done once the next one has started.
const SUMMARY =
	/^(\d+) upgraded, (\d+) newly installed, (?:(\d+) reinstalled, )?(?:(\d+) downgraded, )?\d+ to remove and \d+ not upgraded\.$/gm;
const GET = /^Get:\d+ \S+ .* \[[0-9][0-9.,]* [kMGT]?B\]$/m;
// apt-get's own plan lists; only their packages' dpkg steps are counted.
const PLAN_LIST =
	/^The following (?:NEW )?packages will be (?:upgraded|installed|REINSTALLED|DOWNGRADED):\n((?: {2}.*\n)+)/gm;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/;
const nameOf = (qualified: string) => qualified.split(":")[0] ?? qualified;

function plannedPackages(lines: string): ReadonlySet<string> {
	const planned = new Set<string>();
	for (const list of lines.matchAll(PLAN_LIST))
		for (const name of (list[1] ?? "").split(/\s+/))
			if (PACKAGE.test(nameOf(name))) planned.add(nameOf(name));
	return planned;
}
const DPKG_STEP =
	/^(Unpacking|Setting up) ([a-z0-9][a-z0-9+.:-]*) \([^()\s]+\)(?: over \([^()\s]+\))? \.\.\.$/gm;

export function deriveUpdateProgress(
	stdout: string,
): Omit<SoftUpdateStatus, "result"> {
	const lines = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
	const planned = plannedPackages(lines);
	// Any dpkg step shows the phase; only a planned package's step is counted.
	const stepLines = Array.from(lines.matchAll(DPKG_STEP));
	const steps = new Set(
		stepLines
			.filter((step) => planned.has(nameOf(step[2] ?? "")))
			.map((step) => `${step[1]} ${nameOf(step[2] ?? "")}`),
	).size;
	const phase: Phase =
		stepLines.length > 0
			? "installing"
			: GET.test(lines)
				? "downloading"
				: "preparing";
	let packages = 0;
	for (const plan of lines.matchAll(SUMMARY))
		packages = plan
			.slice(1)
			.reduce((sum, count) => sum + Number(count ?? 0), 0);
	const done = steps - 1;
	const of = 2 * packages;
	if (phase !== "installing" || of === 0 || done <= 0)
		return { ...PHASE_MARKERS[phase] };
	// Kept one step back from 100: only the unit's exit status ends the run.
	return {
		...PHASE_MARKERS[phase],
		percent: Math.min(99, Math.floor((done * 100) / of)),
	};
}

/** The same phase without a number: what is shown while progress cannot be read. */
export function withoutNumber(
	status: Omit<SoftUpdateStatus, "result">,
): Omit<SoftUpdateStatus, "result"> {
	if (status.setting_up > 0 || status.unpacking > 0)
		return { ...PHASE_MARKERS.installing };
	return {
		...PHASE_MARKERS[status.downloading > 0 ? "downloading" : "preparing"],
	};
}
