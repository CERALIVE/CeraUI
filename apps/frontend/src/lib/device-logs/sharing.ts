/**
 * Wire facts of System Logs sharing: which Raw logs query "Export this view"
 * saves, how a refusal reads, and how a ticketed file reaches the browser.
 */
import type {
	LogBootInfo,
	LogBundleFailureReason,
	LogBundleManifest,
	LogErrorCode,
	LogExportInput,
	LogExportOutput,
	LogQueryInput,
} from "@ceraui/rpc/schemas";
import {
	logBundleManifestSchema,
	logExportOutputSchema,
} from "@ceraui/rpc/schemas";

import { RpcError } from "$lib/rpc/rpc-error";

export { chineseWordChunks } from "./cjk-words";

export type SharingProblem = "busy" | "failed";
export type ExportProblem =
	| SharingProblem
	| "credentialTooShort"
	| "credentialsLoading"
	| "credentialsUnreadable";

export function exportCredentialProblem(error: unknown): ExportProblem | null {
	if (!(error instanceof RpcError)) return null;
	switch (error.message) {
		case "CREDENTIAL_TOO_SHORT":
			return "credentialTooShort";
		case "CREDENTIALS_LOADING":
			return "credentialsLoading";
		case "CREDENTIAL_READ_FAILED":
			return "credentialsUnreadable";
		default:
			return null;
	}
}

/** What "Export this view" saves: the Raw logs filters, or the ten minutes around an exact anchor. */
export type ExportSpan = "filters" | "moment";

/** The Raw logs tab's opening view: this boot, errors through info, every source. */
export const RAW_OPENING_QUERY: LogQueryInput = {
	sources: [],
	levels: ["error", "warning", "info"],
	boot: "current",
};

/** What one Export saves: fixed when its confirmation opens, stated there and sent as is. */
export interface ExportScope {
	readonly query: LogQueryInput;
	readonly span: ExportSpan;
	/** When the saved boot started, if it is the picker's boot; otherwise unknown. */
	readonly bootStart: number | null;
}

/**
 * The operator's latest action decides what Export saves: Raw's view as it last
 * published it (an exact moment included), unless the boot picker was used after
 * it or Raw never published; then Raw's level, source and search filters with the
 * picker's boots, which replace Raw's time window as they do in Raw.
 */
export function captureExportScope(
	view: LogQueryInput,
	span: ExportSpan,
	boot: LogBootInfo | null,
	pickerLeads: boolean,
): ExportScope {
	if (!pickerLeads)
		return Object.freeze({
			query: Object.freeze({ ...view }),
			span,
			bootStart:
				boot !== null && boot.bootId === view.boot ? boot.firstTs : null,
		});
	const { sources, levels, text } = view;
	return Object.freeze({
		query: Object.freeze({
			sources,
			levels,
			text,
			boot: boot === null ? "all" : boot.current ? "current" : boot.bootId,
		}),
		span: "filters",
		bootStart: boot?.firstTs ?? null,
	});
}

export function exportInput(query: LogQueryInput): LogExportInput {
	const { sources, levels, text, boot, since, until } = query;
	return { filter: { sources, levels, text }, boot, since, until };
}

// The paths the device mints: its own route and a 32-byte ticket in lowercase hex.
// Nothing else is joined to the backend origin, so no reply can point a download elsewhere.
const TICKET_PATH = {
	export: /^\/api\/logs\/export\?ticket=[0-9a-f]{64}$/,
	bundle: /^\/api\/logs\/bundle\?ticket=[0-9a-f]{64}$/,
};

/** A ticket reply for `kind`: wire-valid, and a success names only that flow's backend path. */
export function ticketReply(
	value: unknown,
	kind: keyof typeof TICKET_PATH,
): LogExportOutput {
	const reply = logExportOutputSchema.parse(value);
	if (reply.ok && !TICKET_PATH[kind].test(reply.url))
		throw new Error(`Unexpected ${kind} ticket path`);
	return reply;
}

/** A preview manifest: wire-valid, naming each section once (its rows are keyed by section). */
export function bundleManifestReply(value: unknown): LogBundleManifest {
	const manifest = logBundleManifestSchema.parse(value);
	if (
		new Set(manifest.sections.map(({ id }) => id)).size !==
		manifest.sections.length
	)
		throw new Error("Bundle manifest names a section twice");
	return manifest;
}

export function refusal(error: LogErrorCode): SharingProblem {
	return error === "BUSY" ? "busy" : "failed";
}

/**
 * The stage at which the device refused to prepare the bundle: its sanitized
 * READ_FAILED (which includes the fail-closed collision of a held secret with a
 * structured value) and the envelope's additive stage. An older device sends no
 * stage, which reads as unclassified. Null when the device did not refuse.
 */
export function previewFailure(error: unknown): LogBundleFailureReason | null {
	if (!(error instanceof RpcError) || error.message !== "READ_FAILED")
		return null;
	return error.stage ?? "internal";
}

/**
 * Each stage's sentence. Only collision (change that credential) and
 * journal_read (restart the device) need a remedy the band's Retry and Export
 * this view do not already offer; the 64 KiB secret budget is not reachable
 * with real credentials. The SPA size budget leaves no room for the rest.
 */
export const BUNDLE_FAILURE_COPY_KEYS = {
	collision: "systemLogs.sharing.bundleFailedCollision",
	journal_read: "systemLogs.sharing.bundleFailedJournal",
	pattern: "systemLogs.sharing.bundleFailed",
	budget: "systemLogs.sharing.bundleFailed",
	deadline: "systemLogs.sharing.bundleFailed",
	abort: "systemLogs.sharing.bundleFailed",
	internal: "systemLogs.sharing.bundleFailed",
} as const satisfies Record<LogBundleFailureReason, string>;

/** A preview rejects with its sanitized code as the message (apps/backend/docs/agents/device-log-bundle.md). */
export function previewProblem(error: unknown): SharingProblem {
	return error instanceof RpcError && error.message === "BUSY"
		? "busy"
		: "failed";
}
