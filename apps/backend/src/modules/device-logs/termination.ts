import { readFileSync } from "node:fs";

type ScanStatus = "eof" | "stopped" | "budget";

export function classifyTermination(
	exitCode: number | null,
	signalCode: number | NodeJS.Signals | null,
	intent: {
		readonly status: ScanStatus;
		readonly termSent: boolean;
		readonly killSent: boolean;
		readonly diedBeforeOurSignal: boolean;
	},
): ScanStatus | "READ_FAILED" {
	if (intent.diedBeforeOurSignal) return "READ_FAILED";
	if (signalCode === null)
		return exitCode === 0 ? intent.status : "READ_FAILED";
	if (
		intent.status !== "eof" &&
		((signalCode === "SIGTERM" && intent.termSent) ||
			(signalCode === "SIGKILL" && intent.killSent))
	)
		return intent.status;
	return "READ_FAILED";
}
function readProcessStat(pid: number) {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = text.lastIndexOf(") ");
		if (close < 0 || !text.startsWith(`${pid} (`)) return undefined;
		const fields = text
			.slice(close + 2)
			.trim()
			.split(/\s+/);
		const state = fields[0];
		const startTime = fields[19];
		if (
			state === undefined ||
			state.length !== 1 ||
			startTime === undefined ||
			!/^\d+$/.test(startTime)
		)
			return undefined;
		return { state, startTime };
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ESRCH")
		)
			return null;
		return undefined;
	}
}

interface Child {
	readonly pid?: number;
	readonly exitCode?: number | null;
	readonly signalCode: number | NodeJS.Signals | null;
	readonly killed?: boolean;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export function trackOwnership(child: Child) {
	const processAtSpawn =
		process.platform === "linux" && child.pid !== undefined
			? readProcessStat(child.pid)
			: undefined;
	const startTime = processAtSpawn?.startTime;
	let sent = false;
	let diedBeforeOurSignal = false;
	return {
		get diedBeforeOurSignal() {
			return diedBeforeOurSignal;
		},
		send(signal: "SIGTERM" | "SIGKILL"): boolean {
			const stat =
				process.platform === "linux" && child.pid !== undefined
					? readProcessStat(child.pid)
					: undefined;
			const dead =
				child.exitCode != null ||
				child.signalCode != null ||
				child.killed === true ||
				processAtSpawn === null ||
				stat === null ||
				(stat !== undefined &&
					(stat.state === "Z" ||
						stat.state === "X" ||
						(startTime !== undefined && stat.startTime !== startTime)));
			if (dead) {
				if (!sent) diedBeforeOurSignal = true;
				return false;
			}
			try {
				child.kill(signal);
				sent = true;
				return true;
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ESRCH"
				) {
					if (!sent) diedBeforeOurSignal = true;
					return false;
				}
				throw error;
			}
		},
	};
}
