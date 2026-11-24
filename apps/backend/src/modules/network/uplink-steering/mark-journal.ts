import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { SteeringUnavailableError } from "./contracts.ts";
import { markForSlot } from "./mark-layout.ts";

const zone = z.object({ ifname: z.string(), ipv4Cidr: z.string() });
const sequence = z.number().int().min(0).max(0xffffffff);
const mark = z
	.number()
	.int()
	.refine((value) => {
		const slot = (value >>> 8) & 0xffff;
		return slot !== 0 && markForSlot(slot) === value;
	});
const claim = z.object({
	identity: z.string().min(1),
	mark,
	ifname: z.string().min(1),
	ifindex: z.number().int().positive(),
	sourceAddress: z.string(),
	table: z.string().min(1),
	epoch: sequence,
});
const image = z.object({
	seq: sequence,
	digest: z.string(),
	claims: z
		.array(claim)
		.refine(
			(claims) =>
				new Set(claims.map((item) => item.identity)).size === claims.length &&
				new Set(claims.map((item) => item.mark)).size === claims.length,
		),
	zones: z.array(zone),
	affected: z.array(mark),
});
const journal = z
	.object({
		version: z.literal(1),
		base: image,
		intent: image.optional(),
		provisional: z.array(claim).default([]),
	})
	.refine(({ base, intent }) => intent === undefined || intent.seq > base.seq);

export type MarkClaim = z.infer<typeof claim>;
export type MarkImage = z.infer<typeof image>;
export type MarkJournal = z.infer<typeof journal>;

export interface MarkJournalStore {
	load(): Promise<MarkJournal | undefined>;
	save(record: MarkJournal): Promise<void>;
}

const JOURNAL_EFFECTS = ["temp", "file-sync", "rename", "dir-sync"] as const;
type JournalEffect = (typeof JOURNAL_EFFECTS)[number];

export function fileMarkJournal(
	path: string,
	afterEffect?: (effect: JournalEffect) => void,
): MarkJournalStore {
	return {
		async load() {
			try {
				return journal.parse(JSON.parse(await readFile(path, "utf8")));
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return undefined;
				throw new SteeringUnavailableError(
					"mark_collision",
					"steering mark journal is unreadable; reboot to recover",
				);
			}
		},
		async save(record) {
			const temp = `${path}.pending`;
			await using file = await open(temp, "w", 0o600);
			await file.writeFile(`${JSON.stringify(record)}\n`);
			afterEffect?.("temp");
			await file.sync();
			afterEffect?.("file-sync");
			await rename(temp, path);
			afterEffect?.("rename");
			await using directory = await open(dirname(path), "r");
			await directory.sync();
			afterEffect?.("dir-sync");
		},
	};
}
