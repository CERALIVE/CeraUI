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

/**
 * What Export saves outside Raw logs: Raw's filters with the boot picker's boots.
 * All boots keeps Raw's time window; a chosen boot replaces it, as it does in Raw.
 */
export function selectionScope(
	view: LogQueryInput,
	boot: LogBootInfo | null,
): LogQueryInput {
	if (boot === null) return { ...view, boot: "all" };
	const { sources, levels, text } = view;
	return {
		sources,
		levels,
		text,
		boot: boot.current ? "current" : boot.bootId,
	};
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
