/**
 * The two Sharing flows of System Logs. "Export this view" fixes its scope when
 * the confirmation opens (`exportScope`), states it there and asks for a ticket
 * for exactly that, whatever Raw publishes meanwhile; the support bundle previews its
 * manifest first, then asks for a ticket. One flow per open view, so it outlives
 * the Downloads region remounting across tabs and the 1024 px breakpoint;
 * `dispose()` when the view closes. Each step takes one request at a time.
 * A reply that does not match its wire schema, a ticket path the device did not
 * mint for that flow, a manifest naming a section twice, a refused call and a
 * download the browser refuses all read as failed, with the step kept for
 * another try. Pressing the dialog's download button again requests a fresh
 * ticket; the same connection can replace an unused ticket, not a running
 * download. A bundle the device refuses to prepare (READ_FAILED, including a
 * secret collision) also offers Export this view instead.
 * Cancel, a deleted history and `dispose()` advance the run a request was sent
 * under, so its late reply is discarded and can never start a download. A ticket the device minted for a discarded reply expires
 * there within 60 s. No timer is kept here.
 */
import type {
	LogBootInfo,
	LogBundleFailureReason,
	LogBundleManifest,
	LogExportInput,
	LogExportOutput,
	LogQueryInput,
} from "@ceraui/rpc/schemas";

import { untrack } from "svelte";

import { onHistoryChanged } from "./history-bus";
import {
	bundleManifestReply,
	captureExportScope,
	type ExportScope,
	type ExportSpan,
	exportInput,
	previewFailure,
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
	/** The boot picker: Export follows it when it was used after Raw's last view (its `intent` moved on). */
	readonly picker?: {
		readonly boot: LogBootInfo | null;
		readonly intent: number;
	};
}

export type ExportStep = "closed" | "confirm" | "creating";
export type BundleStep = "closed" | "previewing" | "preview" | "creating";

// A call that threw or answered off its schema: a failure, but no device refusal.
const UNANSWERED: LogExportOutput = { ok: false, error: "READ_FAILED" };

async function ticket(
	call: () => Promise<LogExportOutput>,
	kind: "export" | "bundle",
): Promise<LogExportOutput> {
	try {
		return ticketReply(await call(), kind);
	} catch (error) {
		console.error("System Logs sharing failed:", error);
		return UNANSWERED;
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
	/** Whether {@link view} is the filters or the ten minutes around an exact anchor. */
	viewSpan = $state<ExportSpan>("filters");
	/** What the open Export confirmation states and its ticket request sends; null while closed. */
	exportScope = $state.raw<ExportScope | null>(null);
	exportStep = $state<ExportStep>("closed");
	exportProblem = $state<SharingProblem | null>(null);
	bundleStep = $state<BundleStep>("closed");
	bundleProblem = $state<SharingProblem | null>(null);
	/** The bundle problem is the device refusing to prepare it, which Export this view avoids. */
	bundleRefused = $state(false);
	/** The device's sanitized stage of a refused preview, which picks its sentence. */
	bundleFailure = $state<LogBundleFailureReason | null>(null);
	manifest = $state.raw<LogBundleManifest | null>(null);

	readonly #deps: SharingDeps;
	readonly #stopHistory: () => void;
	// The picker's intent when Raw last published; none until it does.
	#publishedAt: number | undefined;
	#exportRun = 0;
	#bundleRun = 0;
	#viewOwner: object | undefined;
	#disposed = false;

	constructor(deps: SharingDeps) {
		this.#deps = deps;
		this.#stopHistory = onHistoryChanged(() => this.#historyChanged());
	}

	/** One mounted Raw panel publishes; its snapshot survives a switch to Storage. */
	bindView(): {
		publish(query: LogQueryInput, span?: ExportSpan): void;
		dispose(): void;
	} {
		const owner = {};
		if (!this.#disposed) this.#viewOwner = owner;
		return {
			publish: (query, span = "filters") => {
				if (this.#viewOwner !== owner) return;
				this.view = query;
				this.viewSpan = span;
				this.#publishedAt = this.#pickerIntent();
			},
			dispose: () => {
				if (this.#viewOwner === owner) this.#viewOwner = undefined;
			},
		};
	}

	openExport(): void {
		if (this.exportStep !== "closed") return;
		const intent = this.#pickerIntent();
		this.exportScope = captureExportScope(
			this.view,
			this.viewSpan,
			this.#deps.picker?.boot ?? null,
			intent !== undefined && intent !== this.#publishedAt,
		);
		this.exportStep = "confirm";
	}

	async confirmExport(): Promise<void> {
		const scope = this.exportScope;
		if (this.exportStep !== "confirm" || scope === null) return;
		const run = this.#exportRun;
		this.exportStep = "creating";
		this.exportProblem = null;
		const input = exportInput(scope.query);
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
		this.exportScope = null;
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
		this.bundleRefused = false;
		const reply = await ticket(() => this.#deps.logs.createBundle(), "bundle");
		if (run !== this.#bundleRun) return;
		if (reply.ok && started(this.#deps.download, reply.url)) {
			this.closeBundle();
			return;
		}
		this.bundleProblem = reply.ok ? "failed" : refusal(reply.error);
		this.bundleRefused =
			reply !== UNANSWERED && !reply.ok && reply.error === "READ_FAILED";
		this.bundleStep = "preview";
	}

	closeBundle(): void {
		this.#bundleRun++;
		this.bundleStep = "closed";
		this.manifest = null;
		this.bundleProblem = null;
		this.bundleRefused = false;
		this.bundleFailure = null;
	}

	/** Leaves a bundle the device refused for the Export this view confirmation. */
	exportInstead(): void {
		this.closeBundle();
		this.openExport();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#viewOwner = undefined;
		this.view = RAW_OPENING_QUERY;
		this.viewSpan = "filters";
		this.#publishedAt = undefined;
		this.#stopHistory();
		this.closeExport();
		this.closeBundle();
	}

	// Read without tracking: a publication can run inside a Raw effect.
	#pickerIntent(): number | undefined {
		const picker = this.#deps.picker;
		return picker === undefined ? undefined : untrack(() => picker.intent);
	}

	async #preview(): Promise<void> {
		const run = ++this.#bundleRun;
		this.bundleStep = "previewing";
		this.manifest = null;
		this.bundleProblem = null;
		this.bundleRefused = false;
		this.bundleFailure = null;
		let manifest: LogBundleManifest | null = null;
		let problem: SharingProblem | null = null;
		let failure: LogBundleFailureReason | null = null;
		try {
			manifest = bundleManifestReply(await this.#deps.logs.previewBundle());
		} catch (error) {
			problem = previewProblem(error);
			failure = previewFailure(error);
			if (problem === "failed")
				console.error("System Logs sharing failed:", error);
		}
		if (run !== this.#bundleRun) return;
		this.manifest = manifest;
		this.bundleProblem = problem;
		this.bundleRefused = failure !== null;
		this.bundleFailure = failure;
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
