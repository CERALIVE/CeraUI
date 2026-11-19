import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";

export async function clearNativeJournal(
	retainUntil: (settlement: Promise<unknown>) => void,
): Promise<void> {
	await runJournalMutation(["--rotate"], retainUntil);
	await runJournalMutation(
		["--vacuum-time=1s", "--vacuum-files=1"],
		retainUntil,
	);
}

async function runJournalMutation(
	args: readonly string[],
	retainUntil: (settlement: Promise<unknown>) => void,
): Promise<void> {
	const rotates = args[0] === "--rotate";
	let settlement: Promise<unknown> | undefined;
	try {
		await run("journalctl", [...args], {
			...(rotates ? { preserveChild: true } : {}),
			onChildExit(exited) {
				settlement = rotates ? exited.then(acknowledgeRotation) : exited;
				// The bounded command can still be unwinding when this rejects.
				void settlement.catch(() => undefined);
			},
		});
	} catch (error) {
		if (settlement) retainUntil(settlement);
		throw error;
	}
}

async function acknowledgeRotation(code: number): Promise<void> {
	if (code === 0) return;
	logger.warn("Journal rotation reply lost, awaiting daemon barrier", {
		module: "device-logs",
		code,
	});
	// In systemd v257 Synchronize replies at a lower priority than Rotate.
	// The reaped client can no longer submit. See device-log-retention.md.
	for (let backoff = 1_000; ; backoff = Math.min(backoff * 2, 30_000)) {
		try {
			await run("journalctl", ["--sync"], { timeout: 5_000 });
			return;
		} catch {
			await delay(backoff, undefined, { ref: false });
		}
	}
}
