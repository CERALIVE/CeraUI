import type { DownloadPausedRecord } from "../../modules/system/update-orchestrator/download-paused-ledger.ts";
import {
	type DownloadPausedNoticePorts,
	DownloadPausedNotices,
} from "../../modules/system/update-orchestrator/download-paused-notices.ts";

export function downloadNoticeFixture(
	overrides: Partial<DownloadPausedNoticePorts> = {},
) {
	let entries: readonly DownloadPausedRecord[] = [];
	const publications: string[] = [];
	const diagnostics: string[] = [];
	const worker = new DownloadPausedNotices({
		ledger: {
			read: () => entries,
			write: (next) => {
				entries = next;
			},
			acknowledge: (id) => {
				entries = entries.map((entry) =>
					entry.id === id ? { ...entry, status: "acknowledged" } : entry,
				);
			},
		},
		publish: (fact) => {
			publications.push(fact.id);
		},
		clear: () => undefined,
		report: (reason) => {
			diagnostics.push(reason);
		},
		...overrides,
	});
	return { worker, publications, diagnostics, entries: () => entries };
}
