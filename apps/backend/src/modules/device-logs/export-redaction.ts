import type { LogEntry } from "@ceraui/rpc/schemas";
import { credentialStoresState } from "../../helpers/credential-store-state.ts";
import { collectHeldSecrets, SHORT_VALUE_EXPORT_KINDS } from "./bundle-data.ts";
import { exportEntry, type KnownMatch } from "./export-format.ts";
import {
	clipJournalMessage,
	journalTextBeforeCut,
	type RawJournalRecord,
	toLogEntry,
} from "./parse.ts";
import { buildRedactor, MIN_REDACTED_LENGTH } from "./redaction.ts";

const entities: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};

function unwrapped(text: string): string {
	return text
		.replace(/[\r\n\p{Default_Ignorable_Code_Point}]/gu, "")
		.normalize("NFC");
}

function decoded(text: string, formSpaces: boolean): string {
	return text.replace(
		/(?:%[\da-f]{2})+|\+|&(?:#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,
		(token) => {
			if (token === "+") return formSpaces ? " " : token;
			if (token.startsWith("%")) {
				try {
					return decodeURIComponent(token);
				} catch (error) {
					if (!(error instanceof URIError)) throw error;
					return token;
				}
			}
			const entity = token.slice(1, -1).toLowerCase();
			if (!entity.startsWith("#")) return entities[entity] ?? token;
			const point = entity.startsWith("#x")
				? Number.parseInt(entity.slice(2), 16)
				: Number(entity.slice(1));
			return point <= 0x10ffff ? String.fromCodePoint(point) : token;
		},
	);
}

type ExportRefusal =
	| "CREDENTIALS_LOADING"
	| "CREDENTIAL_TOO_SHORT"
	| "READ_FAILED";
type CredentialPolicy =
	| {
			readonly ok: false;
			readonly error: ExportRefusal;
			readonly footer?: string;
	  }
	| {
			readonly ok: true;
			readonly known: KnownMatch;
			readonly unredacted: readonly string[];
			readonly changed: () => boolean;
			readonly project: (record: RawJournalRecord) => LogEntry;
			readonly format: (entry: LogEntry) => string;
	  };

export function exportCredentialPolicy(): CredentialPolicy {
	const stores = credentialStoresState();
	if (stores === "pending") return { ok: false, error: "CREDENTIALS_LOADING" };
	if (stores === "failed") return { ok: false, error: "READ_FAILED" };
	try {
		const secrets = collectHeldSecrets();
		const snapshot = JSON.stringify(secrets);
		const exact = buildRedactor(secrets);
		const canonical = buildRedactor(
			secrets
				.filter(({ value }) => value.length >= MIN_REDACTED_LENGTH)
				.map(({ kind, value }) => ({ kind, value: unwrapped(value) })),
		);
		const blocking = [
			...new Set([
				...exact.unredacted.filter(
					(kind) => !SHORT_VALUE_EXPORT_KINDS.has(kind),
				),
				...canonical.unredacted,
			]),
		].sort();
		if (blocking.length) {
			const error = "CREDENTIAL_TOO_SHORT";
			const named = `${error} (${blocking.join(", ")})`;
			return {
				ok: false,
				error,
				footer:
					exact.known(`# incomplete: ${named}\n`).redactions === 0
						? named
						: error,
			};
		}
		const matches = (text: string) =>
			exact.known(text).redactions > 0 ||
			canonical.known(unwrapped(text)).redactions > 0 ||
			canonical.known(unwrapped(decoded(text, false))).redactions > 0 ||
			(text.includes("+") &&
				canonical.known(unwrapped(decoded(text, true))).redactions > 0);
		const known: KnownMatch = (text) => {
			const result = exact.known(text);
			if (!matches(result.text)) return result;
			const marker = "[REDACTED]";
			return {
				text: matches(marker) ? "" : marker,
				redactions: result.redactions + 1,
			};
		};
		return {
			ok: true,
			known,
			unredacted: exact.unredacted,
			changed() {
				try {
					return (
						credentialStoresState() !== "ready" ||
						JSON.stringify(collectHeldSecrets()) !== snapshot
					);
				} catch {
					return true;
				}
			},
			project(record) {
				const entry = toLogEntry(record);
				const raw = journalTextBeforeCut(record);
				const message = raw?.message ?? entry.message;
				const cleanUnit = known(entry.unit);
				const cleanMessage = known(message);
				const joined = known(entry.unit + message);
				// A credential reconstructed across the field boundary has no safe component.
				if (
					entry.marker !== "suppressed" &&
					joined.text !== cleanUnit.text + cleanMessage.text
				) {
					return {
						...entry,
						unit: "",
						message: matches("[REDACTED]") ? "" : "[REDACTED]",
					};
				}
				const unit = raw?.unit === undefined ? null : known(raw.unit);
				return {
					...entry,
					unit: unit?.redactions
						? unit.text.replace(/\.service$/, "")
						: cleanUnit.text,
					message: clipJournalMessage(cleanMessage.text),
				};
			},
			format(entry) {
				const rendered = known(exportEntry(entry)).text;
				// A whole-entry fallback still needs a record delimiter.
				return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
			},
		};
	} catch {
		return { ok: false, error: "READ_FAILED" };
	}
}
