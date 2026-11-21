import type { UpdateProgress } from "@ceraui/rpc/schemas";

export type SoftUpdateStatus = Omit<UpdateProgress, "result"> & {
	result?: string | 0;
};

type Phase = "preparing" | "downloading" | "installing";

const PHASE_ORDER = { preparing: 0, downloading: 1, installing: 2 } as const;

// The step fields are phase markers: update-state reads a nonzero
// unpacking/setting_up as "installing", and total stays at 1 so an older
// release's page cannot compute a full bar from them.
export const PHASE_MARKERS = {
	preparing: { total: 0, downloading: 0, unpacking: 0, setting_up: 0 },
	downloading: { total: 1, downloading: 1, unpacking: 0, setting_up: 0 },
	installing: { total: 1, downloading: 0, unpacking: 0, setting_up: 1 },
} as const;

// APT writes each APT::Status-Fd record as one complete line:
// "dlstatus:<item>:<percent>:<text>" while fetching (apt-pkg/acquire.cc) and
// "pmstatus:<package>:<percent>:<text>" from just before dpkg's first fork
// (apt-pkg/install-progress.cc). The percentage counts dpkg state changes APT
// verified for its own plan and keeps one step back from 100.
const STATUS_RECORD = /^(dlstatus|pmstatus):[^:\n]*:(\d{1,3}(?:\.\d+)?):/;

// Coarse evidence for a unit without the status channel: APT prints Get: only
// while fetching and dpkg prints its records only once it runs, so neither can
// appear early. It never yields a number.
function transcriptPhase(stdout: string): Phase {
	if (/(?:Unpacking|Setting up) [a-z0-9][a-z0-9+.:-]* \(/.test(stdout))
		return "installing";
	return /Get:\d+ /.test(stdout) ? "downloading" : "preparing";
}

export function deriveUpdateProgress(
	stdout: string,
	status: string,
): Omit<SoftUpdateStatus, "result"> {
	let reported: Phase = "preparing";
	let percent: number | undefined;
	let failed = false;
	// A record still being written earns nothing until its newline lands.
	for (const line of status
		.slice(0, status.lastIndexOf("\n") + 1)
		.split("\n")) {
		// A package error freezes the number; only the exit code can end the run.
		if (line.startsWith("pmerror:")) failed = true;
		const record = STATUS_RECORD.exec(line);
		const value = Number(record?.[2]);
		if (failed || !record || value > 100) continue;
		const phase = record[1] === "pmstatus" ? "installing" : "downloading";
		if (PHASE_ORDER[phase] < PHASE_ORDER[reported]) continue;
		// APT's estimate can dip (a new fetch item, trigger work); hold the
		// phase's highest so the number never moves backward.
		const shown = Math.min(99, Math.floor(value));
		percent =
			phase === reported && percent !== undefined
				? Math.max(percent, shown)
				: shown;
		reported = phase;
	}
	const fromTranscript = transcriptPhase(stdout);
	const phase =
		PHASE_ORDER[fromTranscript] > PHASE_ORDER[reported]
			? fromTranscript
			: reported;
	return {
		...PHASE_MARKERS[phase],
		...(phase === reported && percent !== undefined ? { percent } : {}),
	};
}
