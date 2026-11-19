import { journalCursorBoot } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { run } from "../../helpers/run.ts";
import { currentBootId } from "./boot-id.ts";
import {
	journalArchiveScope,
	withJournalArchiveSnapshot,
} from "./journal-archive-snapshot.ts";
import { JournalReadError } from "./reader.ts";

const id = z.string().regex(/^[0-9a-f]{32}$/);
const headerSchema = z.object({
	path: z.string(),
	machine: id,
	state: z.literal("ARCHIVED"),
	flags: z
		.string()
		.regex(/^(?: (?:SEALED|SEALED_CONTINUOUS|TAIL_ENTRY_BOOT_ID))*$/),
	boot: id,
	count: z
		.string()
		.regex(/^[1-9]\d*$/)
		.transform(Number)
		.pipe(z.number().int().safe()),
});
const entry = z.object({ _BOOT_ID: id, __CURSOR: z.string() });

export function parseArchiveHeader(output: string) {
	const field = (key: string) => {
		const lines = output
			.split("\n")
			.filter((line) => line.startsWith(`${key}:`));
		const [line] = lines;
		return lines.length === 1 ? line?.slice(key.length + 1) : undefined;
	};
	const parsed = headerSchema.safeParse({
		path: field("File path")?.trim(),
		machine: field("Machine ID")?.trim(),
		state: field("State")?.trim(),
		flags: field("Compatible flags"),
		boot: field("Boot ID")?.trim(),
		count: field("Entry objects")?.trim(),
	});
	return parsed.success ? parsed.data : null;
}

type ArchiveDecision = "delete" | "keep" | "unverified";
type BootEvidence = {
	readonly boot: string;
	readonly machine: string;
};

async function inspectArchive(
	path: string,
	evidence: BootEvidence,
	signal: AbortSignal,
): Promise<ArchiveDecision> {
	const read = (options: string[]) =>
		run("journalctl", [`--file=${path}`, "--no-pager", ...options], { signal });
	try {
		const header = parseArchiveHeader(await read(["--header"]));
		if (header?.path !== path || header.machine !== evidence.machine)
			return "unverified";
		if (!header.flags.split(" ").includes("TAIL_ENTRY_BOOT_ID"))
			return "unverified";
		if (header.boot === evidence.boot) return "keep";

		const output = await read([
			"-o",
			"json",
			"--all",
			"--lines=all",
			"--output-fields=_BOOT_ID",
		]);
		const lines = output.trim().split("\n");
		if (lines.length !== header.count) return "unverified";
		const previous = header.boot;
		for (const line of lines) {
			const parsed = entry.safeParse(JSON.parse(line));
			if (
				!parsed.success ||
				journalCursorBoot(parsed.data.__CURSOR) !== parsed.data._BOOT_ID
			)
				return "unverified";
			const boot = parsed.data._BOOT_ID;
			if (boot === evidence.boot || boot !== previous) return "keep";
		}
		return "delete";
	} catch (error) {
		if (error instanceof Error) return "unverified";
		throw error;
	}
}

export async function deleteOlderJournal() {
	const boot = currentBootId();
	if (boot === undefined) throw new JournalReadError("READ_FAILED");
	const { machine, directories } = journalArchiveScope();
	const signal = AbortSignal.timeout(30_000);
	let unverifiedArchivesKept = false;
	await withJournalArchiveSnapshot(directories, async (archive) => {
		const result = archive.unclean
			? "unverified"
			: await inspectArchive(archive.path, { boot, machine }, signal);
		switch (result) {
			case "keep":
				break;
			case "delete":
				archive.remove();
				break;
			case "unverified":
				unverifiedArchivesKept = true;
				break;
			default: {
				const unreachable: never = result;
				throw new JournalReadError(unreachable);
			}
		}
	});
	return {
		...(unverifiedArchivesKept
			? { unverifiedArchivesKept: true as const }
			: {}),
	};
}
