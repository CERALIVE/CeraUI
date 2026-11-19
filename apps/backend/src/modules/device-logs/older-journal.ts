import { readFile, stat } from "node:fs/promises";
import { run } from "../../helpers/run.ts";
import { currentBootId, normalizeBootId } from "./boot-id.ts";
import { runJournalMutation } from "./clear-journal.ts";
import { JournalReadError } from "./reader.ts";

export async function vacuumOlderJournal(
	retainUntil: (settlement: Promise<unknown>) => void,
): Promise<void> {
	const boot = currentBootId();
	if (boot === undefined) throw new JournalReadError("READ_FAILED");
	const headers = await run("journalctl", ["--header"]);
	const text = await readFile("/proc/uptime", "utf8");
	const uptime = Number(/^\d+(?:\.\d+)?(?=\s)/.exec(text)?.[0]);
	const fallback = Math.ceil(uptime) + 60;
	if (!Number.isSafeInteger(fallback) || fallback < 60)
		throw new JournalReadError("READ_FAILED");

	let earliest = Infinity;
	for (const header of headers.split(/(?=^File path: )/m)) {
		const path = /^File path: (.+)$/m.exec(header)?.[1];
		// Vacuum considers archived names, including uncleanly closed journals.
		if (!path || !/[^/]*(?:@[^/]*\.journal|\.journal~)$/.test(path)) continue;
		if (/^Entry objects: 0$/m.test(header)) continue;
		const id = /^Boot ID: ([0-9a-f]{32})$/im.exec(header)?.[1];
		if (
			id === undefined ||
			!/^Compatible flags:.*\bTAIL_ENTRY_BOOT_ID\b/m.test(header)
		)
			throw new JournalReadError("READ_FAILED");
		if (normalizeBootId(id) !== boot) continue;
		const raw = /^Head realtime timestamp: .+ \(([0-9a-f]+)\)$/im.exec(
			header,
		)?.[1];
		const head = raw === undefined ? NaN : Number.parseInt(raw, 16);
		if (!Number.isSafeInteger(head) || head <= 0)
			throw new JournalReadError("READ_FAILED");
		// systemd can lower the filename timestamp to the file's metadata
		// timestamps. Creation time can predate the head after a clock step.
		const info = await stat(path);
		earliest = Math.min(
			earliest,
			head,
			...[info.birthtimeMs, info.ctimeMs, info.atimeMs, info.mtimeMs]
				.filter((ms) => ms > 0)
				.map((ms) => Math.floor(ms * 1000)),
		);
	}
	// Round away from the first protected file and allow for spawning journalctl.
	const seconds = Math.max(
		fallback,
		Math.ceil((Date.now() * 1000 - earliest) / 1_000_000) + 1,
	);
	await runJournalMutation([`--vacuum-time=${seconds}s`], retainUntil);
}
