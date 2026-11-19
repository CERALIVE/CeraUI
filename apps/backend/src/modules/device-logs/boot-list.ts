import {
	type EventBootRecord,
	type LogBootInfo,
	logBootInfoSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";

export const journalBootsSchema = z.array(
	z.object({
		boot_id: logBootInfoSchema.shape.bootId,
		index: z.number().int(),
		first_entry: z.number().int().nonnegative().safe(),
		last_entry: z.number().int().nonnegative().safe(),
	}),
);
type JournalBoot = z.infer<typeof journalBootsSchema>[number];

export function assembleBootList(
	journal: readonly JournalBoot[],
	stored: readonly EventBootRecord[],
	current: string | undefined,
): LogBootInfo[] {
	const versions = new Map(stored.map((record) => [record.bootId, record]));
	const rows: LogBootInfo[] = journal.map((boot) => ({
		bootId: boot.boot_id,
		index: boot.index,
		firstTs: Math.floor(boot.first_entry / 1000),
		lastTs: Math.floor(boot.last_entry / 1000),
		current: boot.boot_id === current,
		logsAvailable: true,
		shutdown: boot.boot_id === current ? "current" : "unknown",
		evidence: [],
		versions: versions.get(boot.boot_id)?.versions ?? null,
	}));
	let index = Math.min(0, ...rows.map((row) => row.index));
	for (const record of versions.values()) {
		if (rows.some((row) => row.bootId === record.bootId)) continue;
		index = Math.max(Number.MIN_SAFE_INTEGER, index - 1);
		const startedAt = Math.min(
			Number.MAX_SAFE_INTEGER,
			Math.max(0, Math.floor(record.startedAt)),
		);
		rows.push({
			bootId: record.bootId,
			index,
			firstTs: startedAt,
			lastTs: startedAt,
			current: record.bootId === current,
			logsAvailable: false,
			shutdown: record.bootId === current ? "current" : "unknown",
			evidence: [],
			versions: record.versions,
		});
	}
	return rows.sort((a, b) => b.index - a.index);
}
