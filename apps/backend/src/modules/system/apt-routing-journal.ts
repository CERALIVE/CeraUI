import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import {
	openStoredStateDirectory,
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";

const uidRule =
	/^rule add priority 120 uidrange ([1-9]\d*)-\1 (?:lookup 100000|prohibit)$/;
const route =
	/^route add (?:unreachable default table 100000 metric 4278198272|default(?: (?:via [0-9a-fA-F:.]+|dev [A-Za-z0-9_.-]+|proto [A-Za-z0-9_-]+|scope [A-Za-z0-9_-]+|src [0-9a-fA-F:.]+|pref (?:low|medium|high)|expires \d+sec|onlink))+ table 100000 metric 0)$/;
export const aptRoutingEntrySchema = z
	.object({
		family: z.union([z.literal(4), z.literal(6)]),
		args: z
			.array(z.string().regex(/^[A-Za-z0-9_.:-]+$/))
			.min(3)
			.max(32),
	})
	.strict()
	.refine(
		({ args }) => uidRule.test(args.join(" ")) || route.test(args.join(" ")),
	);
export type AptRoutingEntry = z.infer<typeof aptRoutingEntrySchema>;
const journalSchema = z
	.object({
		schema: z.literal(1),
		entries: z.array(aptRoutingEntrySchema).max(4),
	})
	.strict()
	.refine(
		({ entries }) => new Set(entries.map(entryKey)).size === entries.length,
	);

export const entryKey = (entry: AptRoutingEntry): string =>
	`${entry.family}:${entry.args.join(" ")}`;
export type AptRoutingStore = {
	readonly read: () => Promise<readonly AptRoutingEntry[]>;
	readonly save: (entries: readonly AptRoutingEntry[]) => void;
};
export const APT_ROUTING_JOURNAL =
	"/data/ceralive/update-state/apt-routing.json";

export function aptRoutingFileStore(
	path = APT_ROUTING_JOURNAL,
): AptRoutingStore {
	return {
		async read() {
			const raw = await readStoredStateJson(path, STORED_STATE_LIMITS.settings);
			return raw === undefined ? [] : journalSchema.parse(raw).entries;
		},
		save(entries) {
			const value = JSON.stringify(journalSchema.parse({ schema: 1, entries }));
			const parent = openStoredStateDirectory(dirname(path), true);
			const base = `/proc/self/fd/${parent}`;
			const temporary = `${base}/.apt-routing.${randomUUID()}`;
			let failure: unknown;
			try {
				const fd = openSync(
					temporary,
					constants.O_WRONLY |
						constants.O_CREAT |
						constants.O_EXCL |
						constants.O_NOFOLLOW,
					0o600,
				);
				try {
					writeFileSync(fd, value);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				renameSync(temporary, `${base}/${basename(path)}`);
				fsyncSync(parent);
			} catch (error) {
				failure = error;
			}
			try {
				try {
					unlinkSync(temporary);
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ENOENT"
						)
					)
						failure = new AggregateError(
							[failure, error],
							"APT journal temporary cleanup failed",
						);
				}
			} finally {
				closeSync(parent);
			}
			if (failure !== undefined) throw failure;
		},
	};
}
