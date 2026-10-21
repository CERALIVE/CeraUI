import type {
	DownloadInterruption,
	DownloadPausedStore,
} from "./download-paused-ledger.ts";

export type NoticeDiagnostic =
	| "queue-full"
	| "read-unavailable"
	| "write-failed"
	| "publication-failed"
	| "worker-timeout";

export interface DownloadPausedNoticePorts {
	readonly ledger: DownloadPausedStore;
	readonly publish: (
		fact: DownloadInterruption,
		acknowledge: () => void,
	) => void | Promise<void>;
	readonly clear: (id: string) => void;
	readonly report: (reason: NoticeDiagnostic) => void;
}
