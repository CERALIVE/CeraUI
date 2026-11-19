import { readFileSync } from "node:fs";
import { BOUNDED_SPAWN_TERM_GRACE_MS } from "../../helpers/bounded-spawn.ts";
import type { JournalClock } from "./reader.ts";

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

type StopSignal = "SIGTERM" | "SIGKILL";

export class JournalSignalError extends Error {
	constructor(
		public readonly signal: StopSignal,
		cause: unknown,
	) {
		super("Journal process signal failed", { cause });
		this.name = "JournalSignalError";
	}
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
		send(signal: StopSignal): boolean {
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

export function journalRetirement(
	child: Child,
	clock: Pick<JournalClock, "setTimeout" | "clearTimeout">,
) {
	const owner = trackOwnership(child);
	let termSent = false;
	let killSent = false;
	let failure: JournalSignalError | undefined;
	let grace: number | undefined;
	let retiring = false;
	function sendDuringRetirement(signal: StopSignal): boolean | undefined {
		try {
			return owner.send(signal);
		} catch (error) {
			failure ??= new JournalSignalError(signal, error);
			return undefined;
		}
	}
	return {
		stop() {
			if (retiring) return;
			retiring = true;
			const term = sendDuringRetirement("SIGTERM");
			termSent = term === true;
			if (term === false) return;
			if (child.exitCode != null || child.signalCode != null) return;
			grace = clock.setTimeout(() => {
				grace = undefined;
				killSent = sendDuringRetirement("SIGKILL") === true;
			}, BOUNDED_SPAWN_TERM_GRACE_MS);
		},
		disarm() {
			if (grace !== undefined) clock.clearTimeout(grace);
			grace = undefined;
		},
		get failure() {
			return failure;
		},
		get signals() {
			return {
				termSent,
				killSent,
				diedBeforeOurSignal: owner.diedBeforeOurSignal,
			};
		},
	};
}
