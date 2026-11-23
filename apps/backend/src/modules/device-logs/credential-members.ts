/**
 * Credential values inside journal text, for bundle and export redaction.
 *
 * Journals written before the logger redacted a key can hold a value the
 * backend no longer holds (an SSH password since reset, an old hash), which
 * the held-secret literals cannot find. Two passes find them by the key they
 * sit under:
 *
 * - Structured: when the text is, or contains, a JSON object or array, it is
 *   parsed and walked with the logger's own `isSensitiveKey` rule, parent keys
 *   included, into JSON strings that themselves hold JSON. Every string under
 *   a sensitive key (directly, in an array or in a nested object) is masked
 *   where it occurs as a JSON string token at its encoding depth. Numbers and
 *   booleans are left alone.
 * - Fallback: for text that does not parse, a `"key": "value"` member scan
 *   (plain, or escaped inside a JSON string) masks values whose own key names
 *   a credential by the word rule.
 *
 * Spans cover a value's content only, never its quotes, so the replacement
 * keeps the surrounding JSON intact. A value that is exactly a redaction
 * marker is already masked; one that merely starts with a marker is not.
 */
import { isSensitiveKey } from "../../helpers/logger.ts";
import { isSecretWordKey, keyWords } from "../../helpers/secret-key-words.ts";

export interface CredentialSpan {
	readonly start: number;
	readonly end: number;
	readonly marker: string;
}

const MARKER = /^\[REDACTED(?::[a-z0-9_]+)?\]$/;

/** JSON strings that hold JSON are followed this many levels deep. */
const MAX_DEPTH = 4;

/**
 * Fallback member scan. Group 1 is the key, group 2 the value's content; each
 * match ends at the value's closing quote. Between colon and value the escaped
 * form also accepts an encoded newline, return or tab.
 */
const MEMBERS: readonly RegExp[] = [
	/"([A-Za-z0-9_.-]{1,64})"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
	/\\"([A-Za-z0-9_.-]{1,64})\\"(?:\s|\\[nrt])*:(?:\s|\\[nrt])*\\"((?:\\\\\\\\|\\\\\\"|\\\\[^"\\]|[^"\\])*)\\"/g,
];

/** Cheap gate before the member scan: no `"` followed by `:` means no member. */
const MEMBER_HINT = /"\s*:/;

function credentialKind(...keys: readonly string[]): string {
	const words = keys.flatMap((key) => keyWords(key));
	if (words.includes("ssh")) return "ssh";
	if (words.includes("remote")) return "remote_key";
	if (words.includes("pairing")) return "pairing";
	if (words.includes("passphrase")) return "passphrase";
	if (words.some((word) => word.startsWith("pass") || word === "pwd"))
		return "password";
	return "credential";
}

function escapeJson(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}

function encode(text: string, depth: number): string {
	let out = text;
	for (let level = 0; level < depth; level++) out = escapeJson(out);
	return out;
}

function parseContainer(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

interface Found {
	readonly value: string;
	readonly depth: number;
	readonly kind: string;
}

function leaves(node: unknown, depth: number, kind: string, out: Found[]) {
	if (typeof node === "string") {
		if (node !== "" && !MARKER.test(node))
			out.push({ value: node, depth, kind });
	} else if (Array.isArray(node)) {
		for (const item of node) leaves(item, depth, kind, out);
	} else if (typeof node === "object" && node !== null) {
		for (const inner of Object.values(node)) leaves(inner, depth, kind, out);
	}
}

function walk(
	node: unknown,
	parentKey: string | undefined,
	depth: number,
	out: Found[],
) {
	if (Array.isArray(node)) {
		for (const item of node) walk(item, parentKey, depth, out);
	} else if (typeof node === "object" && node !== null) {
		for (const [key, inner] of Object.entries(node)) {
			if (isSensitiveKey(key, parentKey))
				leaves(inner, depth, credentialKind(parentKey ?? "", key), out);
			else walk(inner, key, depth, out);
		}
	} else if (typeof node === "string" && depth < MAX_DEPTH) {
		const parsed = parseContainer(node);
		if (parsed !== undefined) walk(parsed, parentKey, depth + 1, out);
	}
}

/** The first non-whitespace character at or after `from`, without copying. */
function nextVisible(text: string, from: number): string {
	let at = from;
	while (at < text.length && /\s/.test(text.charAt(at))) at++;
	return text.charAt(at);
}

function structuredSpans(text: string): CredentialSpan[] {
	if (!text.includes("{") && !text.includes("[")) return [];
	let root = parseContainer(text);
	if (root === undefined) {
		const open = text.indexOf("{");
		const close = text.lastIndexOf("}");
		if (open >= 0 && close > open)
			root = parseContainer(text.slice(open, close + 1));
	}
	if (root === undefined) return [];
	const found: Found[] = [];
	walk(root, undefined, 1, found);
	// One scan per distinct value and depth: a line repeating one value
	// thousands of times must not rescan itself once per copy.
	const distinct = new Map<string, Found>();
	for (const entry of found)
		if (!distinct.has(`${entry.depth}:${entry.value}`))
			distinct.set(`${entry.depth}:${entry.value}`, entry);
	const spans: CredentialSpan[] = [];
	for (const { value, depth, kind } of distinct.values()) {
		const quote = encode('"', depth - 1);
		const content = encode(value, depth);
		const needle = quote + content + quote;
		for (
			let at = text.indexOf(needle);
			at >= 0;
			at = text.indexOf(needle, at + needle.length)
		) {
			// The same text as a key name is not a value.
			if (nextVisible(text, at + needle.length) === ":") continue;
			const start = at + quote.length;
			spans.push({
				start,
				end: start + content.length,
				marker: `[REDACTED:${kind}]`,
			});
		}
	}
	return spans;
}

function memberSpans(text: string): CredentialSpan[] {
	if (!MEMBER_HINT.test(text)) return [];
	const spans: CredentialSpan[] = [];
	for (const [index, pattern] of MEMBERS.entries()) {
		for (const match of text.matchAll(pattern)) {
			const key = match[1] ?? "";
			const value = match[2] ?? "";
			if (!isSecretWordKey(key) || value === "" || MARKER.test(value)) continue;
			const end = match.index + match[0].length - (index === 0 ? 1 : 2);
			spans.push({
				start: end - value.length,
				end,
				marker: `[REDACTED:${credentialKind(key)}]`,
			});
		}
	}
	return spans;
}

/** Non-overlapping credential value spans in `text`, in order. */
export function credentialSpans(text: string): CredentialSpan[] {
	const all = [...structuredSpans(text), ...memberSpans(text)].sort(
		(a, b) => a.start - b.start || b.end - a.end,
	);
	const out: CredentialSpan[] = [];
	for (const span of all) {
		const previous = out.at(-1);
		if (previous && span.start < previous.end) continue;
		out.push(span);
	}
	return out;
}
