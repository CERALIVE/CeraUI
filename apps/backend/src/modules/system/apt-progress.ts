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
// Only complete lines count. APT prints its plan ("N upgraded, M newly
// installed") before acting, "Get:" as it starts each archive and "Fetched"
// once all are in; dpkg prints "Unpacking" and "Setting up" as it starts each
// package's two steps. A step counts as done once the next one has started.
const SUMMARY = /^(\d+) upgraded, (\d+) newly installed/gm;
const GET = /^Get:\d+ /gm;
const FETCHED = /^Fetched /m;
// Not anchored: dpkg's pseudo-terminal can append a step to an unfinished line.
const DPKG_STEP = /(?:Unpacking|Setting up) [a-z0-9][a-z0-9+.:-]* \(/g;

export function deriveUpdateProgress(
	stdout: string,
): Omit<SoftUpdateStatus, "result"> {
	const lines = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
	const steps = lines.match(DPKG_STEP)?.length ?? 0;
	const gets = lines.match(GET)?.length ?? 0;
	const phase: Phase =
		steps > 0 ? "installing" : gets > 0 ? "downloading" : "preparing";
	let packages = 0;
	for (const plan of lines.matchAll(SUMMARY))
		packages = Number(plan[1]) + Number(plan[2]);
	const done =
		phase === "installing"
			? steps - 1
			: FETCHED.test(lines)
				? packages
				: gets - 1;
	const of = phase === "installing" ? 2 * packages : packages;
	if (phase === "preparing" || of === 0 || done <= 0)
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
