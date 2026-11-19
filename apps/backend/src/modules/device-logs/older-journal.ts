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
	tail: z.string().regex(/^[0-9a-f]{1,16}$/),
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
	signal: AbortSignal,
): Promise<ArchiveDecision> {
	const read = (options: string[]) =>
		run("journalctl", [`--file=${path}`, "--no-pager", ...options], { signal });
	let kept: ArchiveDecision = "unverified";
	try {
		const header = parseArchiveHeader(await read(["--header"]));
		if (header?.path !== path || header.machine !== evidence.machine)
			return "unverified";
		const modern = header.flags.split(" ").includes("TAIL_ENTRY_BOOT_ID");
		if (!modern) kept = "legacy";
		if (modern && header.boot === evidence.boot) return "keep";
		if (
			!modern &&
			(evidence.firstTs === undefined ||
				BigInt(`0x${header.tail}`) >= BigInt(evidence.firstTs) * 1000n)
		)
			return "legacy";

		const output = await read([
			"-o",
			"json",
			"--all",
			"--lines=all",
			"--output-fields=_BOOT_ID",
		]);
		const lines = output.trim().split("\n");
		if (lines.length !== header.count) return kept;
		let previous: string | undefined = modern ? header.boot : undefined;
		for (const line of lines) {
			const parsed = entry.safeParse(JSON.parse(line));
			if (
				!parsed.success ||
				journalCursorBoot(parsed.data.__CURSOR) !== parsed.data._BOOT_ID
			)
				return kept;
			const boot = parsed.data._BOOT_ID;
			if (
				boot === evidence.boot ||
				(previous !== undefined && boot !== previous)
			)
				return modern ? "keep" : "legacy";
			previous = boot;
		}
		return "delete";
	} catch (error) {
		if (error instanceof Error) return kept;
		throw error;
	}
}

export async function deleteOlderJournal(firstTs?: number) {
	const boot = currentBootId();
	if (boot === undefined) throw new JournalReadError("READ_FAILED");
	const { machine, directories } = journalArchiveScope();
	const signal = AbortSignal.timeout(30_000);
	let unverifiedArchivesKept = false;
	let legacyArchivesKept = false;
	await withJournalArchiveSnapshot(directories, async (archive) => {
		const result = archive.unclean
			? "unverified"
			: await inspectArchive(archive.path, { boot, machine, firstTs }, signal);
		switch (result) {
			case "keep":
				break;
			case "delete":
				archive.remove();
				break;
			case "unverified":
				unverifiedArchivesKept = true;
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
		...(unverifiedArchivesKept
			? { unverifiedArchivesKept: true as const }
			: {}),
		...(legacyArchivesKept ? { legacyArchivesKept: true as const } : {}),
	};
}
