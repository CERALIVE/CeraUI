/**
 * The two Sharing flows of System Logs. "Export this view" confirms, then asks
 * for a ticket for the Raw logs query in `view`; the support bundle previews its
 * manifest first, then asks for a ticket. One flow per open view, so it outlives
 * the Downloads region remounting across tabs and the 1024 px breakpoint;
 * `dispose()` when the view closes. Each step takes one request at a time.
 * A reply that does not match its wire schema, a ticket path the device did not
 * mint for that flow, a manifest naming a section twice, a refused call and a
 * download the browser refuses all read as failed, with the step kept for
 * another try.
 * Cancel, a deleted history and `dispose()` advance the run a request was sent
 * under, so its late reply is discarded and can never start a download. A ticket the device minted for a discarded reply expires
 * there within 60 s. No timer is kept here.
 */
import type {
	LogBundleManifest,
	LogExportInput,
	LogExportOutput,
	LogQueryInput,
} from "@ceraui/rpc/schemas";

import { onHistoryChanged } from "./history-bus";
import {
	bundleManifestReply,
	exportInput,
	previewProblem,
	RAW_OPENING_QUERY,
	refusal,
	type SharingProblem,
	ticketReply,
} from "./sharing";

export interface SharingDeps {
	readonly logs: {
		createExport(input: LogExportInput): Promise<LogExportOutput>;
		previewBundle(): Promise<LogBundleManifest>;
		createBundle(): Promise<LogExportOutput>;
	};
	readonly download: (path: string) => void;
}

export type ExportStep = "closed" | "confirm" | "creating";
export type BundleStep = "closed" | "previewing" | "preview" | "creating";

async function ticket(
	call: () => Promise<LogExportOutput>,
	kind: "export" | "bundle",
): Promise<LogExportOutput> {
	try {
		return ticketReply(await call(), kind);
	} catch (error) {
		console.error("System Logs sharing failed:", error);
		return { ok: false, error: "READ_FAILED" };
	}
}

function started(download: (path: string) => void, url: string): boolean {
	try {
		download(url);
		return true;
	} catch (error) {
		console.error("System Logs sharing failed:", error);
		return false;
	}
}

export class SharingFlow {
	/** The Raw logs tab's current query: what "Export this view" saves. */
	view = $state.raw<LogQueryInput>(RAW_OPENING_QUERY);
	exportStep = $state<ExportStep>("closed");
	exportProblem = $state<SharingProblem | null>(null);
	bundleStep = $state<BundleStep>("closed");
	bundleProblem = $state<SharingProblem | null>(null);
	manifest = $state.raw<LogBundleManifest | null>(null);

	readonly #deps: SharingDeps;
	readonly #stopHistory: () => void;
	#exportRun = 0;
	#bundleRun = 0;
	#viewOwner: object | undefined;
	#disposed = false;

	constructor(deps: SharingDeps) {
		this.#deps = deps;
		this.#stopHistory = onHistoryChanged(() => this.#historyChanged());
	}

	/** One mounted Raw panel publishes; its snapshot survives a switch to Storage. */
	bindView(): { publish(query: LogQueryInput): void; dispose(): void } {
		const owner = {};
		if (!this.#disposed) this.#viewOwner = owner;
		return {
			publish: (query) => {
				if (this.#viewOwner === owner) this.view = query;
			},
			dispose: () => {
				if (this.#viewOwner === owner) this.#viewOwner = undefined;
			},
		};
	}

	openExport(): void {
		if (this.exportStep !== "closed") return;
		this.exportStep = "confirm";
	}

	async confirmExport(): Promise<void> {
		if (this.exportStep !== "confirm") return;
		const run = this.#exportRun;
		this.exportStep = "creating";
		this.exportProblem = null;
		const input = exportInput(this.view);
		const reply = await ticket(
			() => this.#deps.logs.createExport(input),
			"export",
		);
		if (run !== this.#exportRun) return;
		if (reply.ok && started(this.#deps.download, reply.url)) {
			this.closeExport();
			return;
		}
		this.exportProblem = reply.ok ? "failed" : refusal(reply.error);
		this.exportStep = "confirm";
	}

	closeExport(): void {
		this.#exportRun++;
		this.exportStep = "closed";
		this.exportProblem = null;
	}

	openBundle(): Promise<void> {
		return this.bundleStep === "closed" ? this.#preview() : Promise.resolve();
	}

	retryPreview(): Promise<void> {
		return this.bundleStep === "preview" && this.manifest === null
			? this.#preview()
			: Promise.resolve();
	}

	async downloadBundle(): Promise<void> {
		if (this.bundleStep !== "preview" || this.manifest === null) return;
		const run = this.#bundleRun;
		this.bundleStep = "creating";
		this.bundleProblem = null;
		const reply = await ticket(() => this.#deps.logs.createBundle(), "bundle");
		if (run !== this.#bundleRun) return;
		if (reply.ok && started(this.#deps.download, reply.url)) {
			this.closeBundle();
			return;
		}
		this.bundleProblem = reply.ok ? "failed" : refusal(reply.error);
		this.bundleStep = "preview";
	}

	closeBundle(): void {
		this.#bundleRun++;
		this.bundleStep = "closed";
		this.manifest = null;
		this.bundleProblem = null;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#viewOwner = undefined;
		this.view = RAW_OPENING_QUERY;
		this.#stopHistory();
		this.closeExport();
		this.closeBundle();
	}

	async #preview(): Promise<void> {
		const run = ++this.#bundleRun;
		this.bundleStep = "previewing";
		this.manifest = null;
		this.bundleProblem = null;
		let manifest: LogBundleManifest | null = null;
		let problem: SharingProblem | null = null;
		try {
			manifest = bundleManifestReply(await this.#deps.logs.previewBundle());
		} catch (error) {
			problem = previewProblem(error);
			if (problem === "failed")
				console.error("System Logs sharing failed:", error);
		}
		if (run !== this.#bundleRun) return;
		this.manifest = manifest;
		this.bundleProblem = problem;
		this.bundleStep = "preview";
	}

	// The device invalidated every ticket and its counts changed: an export in
	// flight is reported as not created, and an open bundle previews again.
	#historyChanged(): void {
		if (this.exportStep === "creating") {
			this.#exportRun++;
			this.exportStep = "confirm";
			this.exportProblem = "failed";
		}
		if (this.bundleStep !== "closed") void this.#preview();
	}
}
