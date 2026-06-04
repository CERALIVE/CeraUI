import { setup } from "../modules/setup.ts";
import { ALLOWED, run } from "./run.ts";

const killallBinary = setup.killall_binary ?? "killall";

export default async function killall(
	args: Readonly<Array<string>>,
): Promise<void> {
	if (ALLOWED.has(killallBinary)) {
		try {
			await run(killallBinary, [...args]);
		} catch (_err) {
			// killall exits non-zero when no matching process exists — expected for
			// fire-and-forget orphan cleanup and SIGHUP reloads.
		}
		return;
	}

	// Custom, non-allowlisted setup.killall_binary path: argv-only (NO shell).
	Bun.spawnSync([killallBinary, ...args]);
}
