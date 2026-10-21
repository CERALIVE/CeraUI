import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import { readStoredStateFileSync } from "./stored-state-file.ts";
import { parseAuthorityJson } from "./strict-authority-json.ts";

export const DOWNLOAD_PAUSED_LEDGER_CAPACITY = 4096;

const recordSchema = z.strictObject({
	id: z.string().regex(/^(packages|os):[0-9a-f-]{36}$/),
	candidate: z.string().regex(/^[0-9a-f]{64}$/),
	status: z.enum(["active", "acknowledged", "withdrawn"]),
});
const ledgerSchema = z
	.strictObject({
		schema: z.literal(1),
		entries: z.array(recordSchema).max(DOWNLOAD_PAUSED_LEDGER_CAPACITY),
	})
	.refine(
		({ entries }) =>
			new Set(entries.map((entry) => entry.id)).size === entries.length,
	);

export type DownloadPausedRecord = Readonly<z.infer<typeof recordSchema>>;
export type DownloadInterruption = Pick<
	DownloadPausedRecord,
	"id" | "candidate"
>;

export interface DownloadPausedStore {
	read():
		| readonly DownloadPausedRecord[]
		| Promise<readonly DownloadPausedRecord[]>;
	write(entries: readonly DownloadPausedRecord[]): void | Promise<void>;
	acknowledge(id: string): void;
}

export function precedingHoldEntries(
	entries: readonly DownloadPausedRecord[],
	successorId?: string,
): readonly DownloadPausedRecord[] {
	const index = entries.findIndex((entry) => entry.id === successorId);
	return index < 0 ? entries : entries.slice(0, index);
}

/** Separate informational history; it never grants update or stream authority. */
export class DownloadPausedLedger implements DownloadPausedStore {
	constructor(
		private readonly path = "/data/ceralive/update-state/download-paused-notices.json",
		private readonly syncParent = syncOrchestratorDirectory,
	) {}

	read(): readonly DownloadPausedRecord[] {
		const raw = readStoredStateFileSync(this.path, 1024 * 1024);
		return raw === null
			? []
			: ledgerSchema.parse(parseAuthorityJson(raw)).entries;
	}

	write(entries: readonly DownloadPausedRecord[]): void {
		const ledger = ledgerSchema.parse({ schema: 1, entries });
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileAtomicSync(this.path, JSON.stringify(ledger));
		this.syncParent(this.path);
	}

	acknowledge(id: string): void {
		// Synchronous at the dismissal boundary: never remove an unrecorded ack.
		const entries = this.read();
		this.write(
			entries.map((entry) =>
				entry.id === id ? { ...entry, status: "acknowledged" } : entry,
			),
		);
	}
}
