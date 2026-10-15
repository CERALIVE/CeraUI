import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export type AptAllDiagnosticStep =
	| "source-policy"
	| "package-policy"
	| "parse-simulation"
	| "held-packages"
	| "install-vector"
	| "pinned-simulation"
	| "pinned-recheck";

export function sanitizeAptDiagnostic(text: string): string {
	return prepareAptDiagnostic(text).detail;
}

function redactUrl(text: string): string {
	// Consume disjoint maximal tokens, not every boundary inside a scheme-like run.
	const delimiter = /:\s*\/\s*\//y;
	for (const token of text.matchAll(/[a-z0-9+.-]+/gi)) {
		delimiter.lastIndex = token.index + token[0].length;
		if (!delimiter.test(text)) continue;
		for (const start of token[0].matchAll(/\b[a-z]/gi)) {
			const index = token.index + start.index;
			if (start.index === 0 && /\w/.test(text.charAt(index - 1))) continue;
			return `${text.slice(0, index)}[REDACTED URL]`;
		}
	}
	return text;
}

function redactMarkedRecord(text: string): string {
	const marker =
		/password|passwd|secret|token|authorization|bearer|credential|private[\s._-]?key|sslkey|sslcert|api[\s._-]?key|v\d+\s*\.\s*(?:public|local)\s*\./i.exec(
			text,
		);
	let index = marker?.index ?? text.length;
	// JWT's variable-length word also needs one visit per run, not per "eyJ".
	const dot = /\s*\./y;
	for (const token of text.matchAll(/[\w-]+/g)) {
		if (token.index >= index) break;
		const start = /eyJ[\w-]/i.exec(token[0]);
		if (!start) continue;
		dot.lastIndex = token.index + token[0].length;
		if (dot.test(text)) {
			index = Math.min(index, token.index + start.index);
			break;
		}
	}
	if (index === text.length) return text;
	return `${text.slice(0, text.lastIndexOf("\n", index - 1) + 1)}[REDACTED]`;
}

export function prepareAptDiagnostic(text: string): {
	readonly detail: string;
	readonly fingerprint: string;
} {
	const normalized = stripVTControlCharacters(text)
		.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(/[^\S\n]+/gu, " ")
		.replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "");
	// A marked record owns the remaining text: its continuation boundary is unknown.
	// Keep only independent benign prefixes; never split before secret detection.
	const safe = redactMarkedRecord(
		redactUrl(normalized.replace(/-----BEGIN[\s\S]*/g, "[REDACTED]")),
	)
		.replace(/^[^\n]*\b[A-Z_][A-Z0-9_]*\s*=[\s\S]*/gm, "[REDACTED]")
		.replace(/\s+/gu, " ")
		.trim();
	// Preserve UTF-8 identities; 0xff separates malformed UTF-16 from ALL valid UTF-8.
	const identity = /[\uD800-\uDFFF]/u.test(safe)
		? Buffer.concat([Buffer.from([0xff]), Buffer.from(safe, "utf16le")])
		: safe;
	return {
		detail: safe.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
		fingerprint: createHash("sha256").update(identity).digest("hex"),
	};
}
