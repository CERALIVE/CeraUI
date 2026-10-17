import { z } from "zod";
import type { HelperLaunchFile } from "./helper-launch-file.ts";

const launchPgid = z
	.string()
	.max(32)
	.regex(/^[1-9][0-9]{0,9}\n?$/)
	.transform(Number)
	.pipe(z.number().int().min(2).max(2147483647));
type LaunchIdentity = "present" | "absent" | "unknown";
export type LaunchRecoverySleep = (
	ms: number,
	signal: AbortSignal,
) => Promise<void>;
const sleepHost: LaunchRecoverySleep = (ms, signal) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});

export function helperLaunchRecovery(
	file: HelperLaunchFile,
	sleep: LaunchRecoverySleep = sleepHost,
) {
	let pgid: number | undefined;
	let sawIdentity = false;
	const read = async (signal: AbortSignal): Promise<LaunchIdentity> => {
		if (signal.aborted) return "unknown";
		if (pgid !== undefined) return "present";
		try {
			const text = await file.read();
			if (signal.aborted) return "unknown";
			if (text === null || text === "")
				return sawIdentity ? "unknown" : "absent";
			sawIdentity = true;
			const parsed = launchPgid.safeParse(text);
			if (!parsed.success) return "unknown";
			pgid = parsed.data;
			return "present";
		} catch {
			return "unknown";
		}
	};
	return {
		pgid: () => pgid,
		read,
		settle: async (
			signal: AbortSignal,
			immediate: boolean,
		): Promise<LaunchIdentity> => {
			let identity = await read(signal);
			if (!immediate) {
				for (const ms of [100, 200, 400]) {
					if (identity !== "absent" || signal.aborted) break;
					try {
						await sleep(ms, signal);
					} catch {
						return "unknown";
					}
					identity = await read(signal);
				}
			}
			return signal.aborted ? "unknown" : identity;
		},
	};
}
