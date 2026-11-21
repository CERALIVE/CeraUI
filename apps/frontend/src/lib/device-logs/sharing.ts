/**
 * Wire facts of System Logs sharing: which Raw logs query "Export this view"
 * saves, how a refusal reads, and how a ticketed file reaches the browser.
 */
import type {
	LogBundleFailureReason,
	LogBundleManifest,
	LogErrorCode,
	LogExportInput,
	LogExportOutput,
	LogQueryInput,
} from "@ceraui/rpc/schemas";
import {
	logBundleFailureReason,
	logBundleManifestSchema,
	logExportOutputSchema,
} from "@ceraui/rpc/schemas";

import { getBackendHttpUrl } from "$lib/env";
import { RpcError } from "$lib/rpc/rpc-error";

export { chineseWordChunks } from "./cjk-words";

export type SharingProblem = "busy" | "failed";

/** What "Export this view" saves: the Raw logs filters, or the ten minutes around an exact anchor. */
export type ExportSpan = "filters" | "moment";

/** The Raw logs tab's opening view: this boot, errors through info, every source. */
export const RAW_OPENING_QUERY: LogQueryInput = {
	sources: [],
	levels: ["error", "warning", "info"],
	boot: "current",
};

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
 * The stage at which the device refused to prepare the bundle, from its
 * sanitized READ_FAILED message (which includes the fail-closed collision of a
 * held secret with a structured value), or null when the device did not refuse.
 */
export function previewFailure(error: unknown): LogBundleFailureReason | null {
	return error instanceof RpcError
		? logBundleFailureReason(error.message)
		: null;
}

/** Each stage's sentence; stages share one only where the remedy is the same. */
export const BUNDLE_FAILURE_COPY_KEYS = {
	collision: "systemLogs.sharing.bundleFailedCollision",
	pattern: "systemLogs.sharing.bundleFailedPattern",
	budget: "systemLogs.sharing.bundleFailedBudget",
	journal_read: "systemLogs.sharing.bundleFailedJournal",
	deadline: "systemLogs.sharing.bundleFailedInterrupted",
	abort: "systemLogs.sharing.bundleFailedInterrupted",
	internal: "systemLogs.sharing.bundleFailed",
} as const satisfies Record<LogBundleFailureReason, string>;

/** A preview rejects with its sanitized code as the message (apps/backend/docs/agents/device-log-bundle.md). */
export function previewProblem(error: unknown): SharingProblem {
	return error instanceof RpcError && error.message === "BUSY"
		? "busy"
		: "failed";
}

/** The browser streams the file to disk; the page never holds its bytes. */
export function startBackendDownload(path: string): void {
	const anchor = document.createElement("a");
	anchor.href = getBackendHttpUrl(path);
	anchor.download = "";
	document.body.append(anchor);
	try {
		anchor.click();
	} finally {
		anchor.remove();
	}
}
