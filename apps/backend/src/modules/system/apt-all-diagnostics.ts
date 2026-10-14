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
	const safe = normalized
		.replace(/-----BEGIN[\s\S]*/g, "[REDACTED]")
		.replace(/\b[a-z][a-z0-9+.-]*:\s*\/\s*\/[\s\S]*/gi, "[REDACTED URL]")
		.replace(
			/^[^\n]*(?:password|passwd|secret|token|authorization|bearer|credential|private[\s._-]?key|sslkey|sslcert|api[\s._-]?key|v\d+\s*\.\s*(?:public|local)\s*\.|eyJ[\w-]+\s*\.)[\s\S]*/im,
			"[REDACTED]",
		)
		.replace(/^[^\n]*\b[A-Z_][A-Z0-9_]*\s*=[\s\S]*/gm, "[REDACTED]")
		.replace(/\s+/gu, " ")
		.trim();
	return {
		detail: safe.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
		fingerprint: createHash("sha256").update(safe).digest("hex"),
	};
}
