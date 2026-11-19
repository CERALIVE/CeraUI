import { z } from "zod";
import { run } from "../../helpers/run.ts";
import { currentBootId } from "./boot-id.ts";
import { journalBootsSchema } from "./boot-list.ts";
import {
	journalArchiveScope,
	withJournalArchiveSnapshot,
} from "./journal-archive-snapshot.ts";
import { JournalReadError } from "./reader.ts";

const id = z.string().regex(/^[0-9a-f]{32}$/);
const headerSchema = z.object({
	path: z.string(),
	machine: id,
	state: z.enum(["ARCHIVED", "OFFLINE", "ONLINE"]),
	flags: z
		.string()
		.regex(/^(?: (?:SEALED|SEALED_CONTINUOUS|TAIL_ENTRY_BOOT_ID))*$/),
	boot: id,
	count: z
		.string()
		.regex(/^[1-9]\d*$/)
		.transform(Number)
		.pipe(z.number().int().safe()),
	tail: z.string().regex(/^[0-9a-f]{1,16}$/),
});
const bootIndexSchema = z.array(id).min(1);

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
		tail: / \(([0-9a-f]+)\)$/.exec(field("Tail realtime timestamp") ?? "")?.[1],
	});
	return parsed.success ? parsed.data : null;
}

type ArchiveDecision = "delete" | "keep" | "unverified" | "legacy";
type BootEvidence = {
	readonly boot: string;
	readonly machine: string;
	readonly firstTs: number | undefined;
};

async function inspectArchive(
	path: string,
	evidence: BootEvidence,
	unclean: boolean,
): Promise<ArchiveDecision> {
	const signal = AbortSignal.timeout(10_000);
	const read = (options: string[]) =>
		run("journalctl", [`--file=${path}`, "--no-pager", ...options], {
			signal,
			maxBuffer: 64 * 1024,
		});
	try {
		const header = parseArchiveHeader(await read(["--header"]));
		// Journald discards .journal~ by renaming without updating the state.
		if (
			header?.path !== path ||
			header.machine !== evidence.machine ||
			(!unclean && header.state !== "ARCHIVED")
		)
			return "unverified";
		const modern = header.flags.split(" ").includes("TAIL_ENTRY_BOOT_ID");
		if (modern && header.boot === evidence.boot) return "keep";
		if (
			!modern &&
			(evidence.firstTs === undefined ||
				BigInt(`0x${header.tail}`) >= BigInt(evidence.firstTs) * 1000n)
		)
			return "legacy";

		const listed = journalBootsSchema
			.min(1)
			.safeParse(JSON.parse(await read(["--list-boots", "-o", "json"])));
		if (!listed.success) return "unverified";
		const boots = new Set(listed.data.map(({ boot_id }) => boot_id));
		if (boots.has(evidence.boot)) return "keep";

		// List-boots jumps across each boot's range and can miss an interleaved boot.
		const output = await read(["--field=_BOOT_ID"]);
		const indexed = bootIndexSchema.safeParse(
			output.replace(/\n$/, "").split("\n"),
		);
		if (!indexed.success) return "unverified";
		if (indexed.data.includes(evidence.boot)) return "keep";
		if (
			(modern && !boots.has(header.boot)) ||
			boots.size !== listed.data.length ||
			new Set(indexed.data).size !== boots.size ||
			!indexed.data.every((boot) => boots.has(boot))
		)
			return "unverified";

		// A readable index does not establish the integrity of the archive.
		await read(["--verify", "--quiet"]);
		if (signal.aborted) return "unverified";
		return "delete";
	} catch (error) {
		if (error instanceof Error) return "unverified";
		throw error;
	}
}

export async function deleteOlderJournal(firstTs?: number) {
	const boot = currentBootId();
	if (boot === undefined) throw new JournalReadError("READ_FAILED");
	const { machine, directories } = journalArchiveScope();
	let unverifiedArchivesKeptCount = 0;
	let legacyArchivesKept = false;
	await withJournalArchiveSnapshot(directories, async (archive) => {
		const result = await inspectArchive(
			archive.path,
			{ boot, machine, firstTs },
			archive.unclean,
		);
		switch (result) {
			case "keep":
				break;
			case "delete":
				archive.remove();
				break;
			case "unverified":
				unverifiedArchivesKeptCount++;
				break;
			case "legacy":
				legacyArchivesKept = true;
				break;
			default: {
				const unreachable: never = result;
				throw new JournalReadError(unreachable);
			}
		}
	});
	return {
		unverifiedArchivesKeptCount,
		warnings: {
			...(unverifiedArchivesKeptCount > 0
				? { unverifiedArchivesKept: true as const }
				: {}),
			...(legacyArchivesKept ? { legacyArchivesKept: true as const } : {}),
		},
	};
}
