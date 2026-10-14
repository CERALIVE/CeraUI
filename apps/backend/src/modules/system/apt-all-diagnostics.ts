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
	// Redact before truncation so cutting a credential cannot hide its marker.
	const safe = stripVTControlCharacters(text)
		.replace(
			/-----BEGIN[^-]*-----[\s\S]*?(?:-----END[^-]*-----|$)/g,
			"[REDACTED]",
		)
		.split(/\r\n?|\n/)
		.map((line) => {
			const normalized = line
				.replace(/\s+/gu, " ")
				.replace(/[\p{Cc}\p{Cf}]/gu, "")
				.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[REDACTED URL]");
			if (
				/password|passwd|secret|token|authorization|bearer|credential|private.?key|sslkey|sslcert|api.?key|v\d+\.(?:public|local)\.|eyJ[\w-]+\./i.test(
					normalized,
				) ||
				/\b[A-Z_][A-Z0-9_]*\s*=/.test(normalized)
			)
				return "[REDACTED]";
			return normalized;
		})
		.join(" ")
		.replace(/\s+/gu, " ")
		.trim();
	return safe.slice(0, 500).replace(/[\uD800-\uDBFF]$/, "");
}
