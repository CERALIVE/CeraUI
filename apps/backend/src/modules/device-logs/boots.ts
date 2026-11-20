import type { LogBootInfo } from "@ceraui/rpc/schemas";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { readBoots } from "../events/store.ts";
import { currentBootId } from "./boot-id.ts";
import { assembleBootList, journalBootsSchema } from "./boot-list.ts";
import { scanMockJournal } from "./mock-journal.ts";
import { JournalReadError } from "./reader.ts";

export async function listBoots(): Promise<LogBootInfo[]> {
	const current = currentBootId();
	const stored = readBoots();
	if (shouldUseMocks()) {
		if (current === undefined) throw new JournalReadError("READ_FAILED");
		let first: number | undefined;
		let last = 0;
		await scanMockJournal({
			options: [],
			matches: [],
			onRecord(record) {
				first ??= record.ts;
				last = record.ts;
				return "continue";
			},
		});
		return assembleBootList(
			[
				{
					boot_id: current,
					index: 0,
					first_entry: (first ?? 0) * 1000,
					last_entry: last * 1000,
				},
			],
			stored,
			current,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(
			await run("journalctl", ["--list-boots", "-o", "json"], {
				timeout: 30_000,
			}),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			throw new JournalReadError("JOURNAL_UNAVAILABLE");
		throw new JournalReadError("READ_FAILED");
	}
	const parsed = journalBootsSchema.safeParse(value);
	if (!parsed.success) throw new JournalReadError("READ_FAILED");
	return assembleBootList(parsed.data, stored, current);
}
