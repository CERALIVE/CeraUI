import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";

export async function clearNativeJournal(
	retainUntil: (settlement: Promise<unknown>) => void,
): Promise<void> {
	for (const arg of ["--rotate", "--vacuum-time=1s"]) {
		const rotates = arg === "--rotate";
		let settlement: Promise<unknown> | undefined;
		try {
			await run("journalctl", [arg], {
				...(rotates ? { preserveChild: true } : {}),
				onChildExit(exited) {
					settlement = !rotates
						? exited
						: exited.then(async (code) => {
								if (code === 0) return;
								logger.warn(
									"Journal rotation reply lost, awaiting daemon barrier",
									{
										module: "device-logs",
										code,
									},
								);
								// In systemd v257, Synchronize replies from a lower-priority
								// defer than the listener and all Varlink connection work.
								// The reaped client can no longer submit, and Rotate runs
								// synchronously in that event loop. See device-log-retention.md.
								for (
									let backoff = 1_000;
									;
									backoff = Math.min(backoff * 2, 30_000)
								) {
									try {
										await run("journalctl", ["--sync"], { timeout: 5_000 });
										return;
									} catch {
										await delay(backoff, undefined, { ref: false });
									}
								}
							});
					// The bounded command can still be unwinding when this rejects.
					void settlement.catch(() => undefined);
				},
			});
		} catch (error) {
			if (settlement) retainUntil(settlement);
			throw error;
		}
	}
}
