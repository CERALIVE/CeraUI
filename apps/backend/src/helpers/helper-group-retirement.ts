import type { ServiceCompletion } from "../modules/system/disruptive-service-reservation.ts";

export type HelperGroupObservation = {
	readonly pgid: number;
	readonly exitCode: number | undefined;
};
export type SignalZero = (pid: number, signal: 0) => unknown;

export function helperGroupRetirement(
	read: () => HelperGroupObservation | undefined,
	kill: SignalZero = process.kill,
): (signal: AbortSignal) => Promise<ServiceCompletion> {
	let retired = false;
	return async (signal) => {
		if (signal.aborted) return "unknown";
		if (retired) return "completed";
		const owned = read();
		if (!owned || !Number.isSafeInteger(owned.pgid) || owned.pgid <= 1)
			return "unknown";
		if (owned.exitCode === undefined) return "in-flight";
		if (!Number.isInteger(owned.exitCode) || owned.exitCode < 0)
			return "unknown";
		try {
			kill(-owned.pgid, 0);
			return "in-flight";
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ESRCH")
			)
				return "unknown";
			retired = true;
			return "completed";
		}
	};
}
