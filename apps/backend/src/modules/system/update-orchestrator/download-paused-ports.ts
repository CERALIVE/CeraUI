import type {
	DownloadInterruption,
	DownloadPausedStore,
} from "./download-paused-ledger.ts";

export type NoticeDiagnostic =
	| "queue-full"
	| "ledger-full"
	| "read-unavailable"
	| "write-failed"
	| "publication-failed"
	| "worker-timeout";

export type NoticeAction =
	| { readonly kind: "interrupted"; readonly fact: DownloadInterruption }
	| {
			readonly kind: "withdraw";
			readonly candidate: string;
			readonly successorId?: string;
	  }
	| { readonly kind: "replace-packages"; readonly successorId: string }
	| { readonly kind: "hydrate" };

export interface DownloadPausedNoticePorts {
	readonly ledger: DownloadPausedStore;
	readonly publish: (
		fact: DownloadInterruption,
		acknowledge: () => void,
	) => void | Promise<void>;
	readonly clear: (id: string) => void;
	readonly report: (reason: NoticeDiagnostic) => void;
}
