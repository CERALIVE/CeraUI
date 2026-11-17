/**
 * Wire facts of System Logs sharing: which Raw logs query "Export this view"
 * saves, how a refusal reads, and how a ticketed file reaches the browser.
 */
import type {
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

export type SharingProblem = "busy" | "failed";

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

/**
 * Where fixed Chinese copy may wrap. The browser breaks Chinese between any two
 * characters, so a word such as 分享 can split across lines; this cuts the copy
 * at word boundaries (`Intl.Segmenter`) for `KeepWords` to join with <wbr>. A
 * chunk never starts with punctuation or a one-character word, so particles and
 * suffixes stay with the word before them. Other locales, a browser without a
 * working segmenter and any cut that would not join back to the exact copy get
 * the copy whole.
 */
export function chineseWordChunks(text: string, locale: string): string[] {
	if (!locale.startsWith("zh")) return [text];
	// shortcut: ICU's dictionary decides what a word is, so an unknown compound can still break between its parts; upgrade if Chromium ships word-break: auto-phrase for Chinese.
	try {
		const chunks = [""];
		let wordBefore = false;
		for (const { segment, isWordLike = false } of new Intl.Segmenter(locale, {
			granularity: "word",
		}).segment(text)) {
			if (isWordLike && wordBefore && segment.length > 1) chunks.push("");
			chunks[chunks.length - 1] += segment;
			wordBefore = isWordLike;
		}
		return chunks.join("") === text ? chunks : [text];
	} catch {
		// Without a working segmenter the browser's own line breaking applies.
		return [text];
	}
}
