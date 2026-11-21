import { credentialStoresState } from "../../helpers/credential-store-state.ts";
import { collectVersionContext } from "../system/version-context.ts";
import { listBoots } from "./boots.ts";
import { collectHeldSecrets, SHORT_VALUE_EXPORT_KINDS } from "./bundle-data.ts";
import type { ParsedQuery } from "./continuation.ts";
import { exportEntry, exportHeader, type KnownMatch } from "./export-format.ts";
import { withQuerySlot } from "./query-admission.ts";
import { JournalReadError } from "./reader.ts";
import { buildRedactor } from "./redaction.ts";
import { scanPage } from "./scan-page.ts";
import { getLogState } from "./settings.ts";

export const EXPORT_TIME_MS = 120_000;
const MAX_BYTES = 64 * 1024 * 1024;
const FOOTER_RESERVE = 64;

export function exportAbortReason(signal: AbortSignal): string {
	return signal.reason === "cleared" || signal.reason === "time_limit"
		? signal.reason
		: "client_aborted";
}

export async function* exportChunks(
	query: ParsedQuery,
	bootId: string | null,
	epoch: number,
	signal: AbortSignal,
	createdAt: number,
): AsyncGenerator<Uint8Array> {
	const encoder = new TextEncoder();
	const owner = {};
	let bytes = 0;
	let entries = 0;
	const stopped = () => {
		if (getLogState().historyEpoch !== epoch) return "cleared";
		if (Date.now() - createdAt >= EXPORT_TIME_MS) return "time_limit";
		if (signal.aborted) return exportAbortReason(signal);
		return null;
	};
	const encode = (text: string) => {
		const chunk = encoder.encode(text);
		if (bytes + chunk.byteLength > MAX_BYTES - FOOTER_RESERVE) return null;
		bytes += chunk.byteLength;
		return chunk;
	};
	let incomplete: string | null = stopped();
	// Replace the credentials the backend holds as the export starts, in each
	// entry's unit and message and in the header's values. When that cannot be
	// done for every held credential (apart from the short identifier values
	// below), nothing but the footer is sent. The limits
	// (a snapshot, after journal normalization, fixed footer and filename text)
	// are in docs/agents/device-log-export.md.
	//
	// The matcher skips non-empty values shorter than MIN_REDACTED_LENGTH
	// (UTF-16 code units): matching one to three characters would rewrite
	// ordinary words and numbers all over the log. A short value of a kind in
	// SHORT_VALUE_EXPORT_KINDS (a manually set stream ID, an APN or router user
	// name, a serial) can therefore appear in the file, after the usual
	// formatting, and the header names its kind, never the value. A short value
	// of any other kind (passwords, keys, pairing and relay secrets) still stops
	// the export.
	let known: KnownMatch = (text) => ({ text, redactions: 0 });
	let unredacted: readonly string[] = [];
	const stores = credentialStoresState();
	if (stores === "pending") {
		incomplete ??= "CREDENTIALS_LOADING";
	} else if (stores === "failed") {
		incomplete ??= "READ_FAILED";
	} else {
		try {
			const redactor = buildRedactor(collectHeldSecrets());
			const blocking = redactor.unredacted.filter(
				(kind) => !SHORT_VALUE_EXPORT_KINDS.has(kind),
			);
			if (blocking.length > 0) {
				// The kind list is generated text: if the footer as written would
				// match a held value, name no kinds. The bare status is fixed
				// protocol text and is not checked.
				const named = `CREDENTIAL_TOO_SHORT (${blocking.join(", ")})`;
				incomplete ??=
					redactor.known(`# incomplete: ${named}\n`).redactions === 0
						? named
						: "CREDENTIAL_TOO_SHORT";
			} else {
				known = redactor.known;
				unredacted = redactor.unredacted;
			}
		} catch {
			incomplete ??= "READ_FAILED";
		}
	}
	const redact = (text: string) => known(text).text;
	try {
		if (!incomplete) {
			const boots = await listBoots();
			const covered =
				bootId === null
					? boots
					: boots.filter((boot) => boot.bootId === bootId);
			if (bootId !== null && !covered.some((boot) => boot.logsAvailable)) {
				incomplete = "BOOT_UNAVAILABLE";
			}
			const current = await collectVersionContext();
			incomplete ??= stopped();
			if (!incomplete) {
				const header = encode(
					exportHeader(current, covered, query, createdAt, known, unredacted),
				);
				if (header) yield header;
				else incomplete = "size_limit";
			}
		}
		let position = query;
		while (!incomplete) {
			incomplete = stopped();
			if (incomplete) break;
			const result = await withQuerySlot(
				owner,
				(slotSignal) =>
					scanPage(position, {
						bootId,
						epoch,
						signal: AbortSignal.any([slotSignal, signal]),
					}),
				signal,
			);
			incomplete = stopped();
			if (incomplete) break;
			if (!result.ok) {
				incomplete = result.error;
				break;
			}
			for (const entry of result.entries) {
				incomplete = stopped();
				if (incomplete) break;
				const chunk = encode(
					redact(
						exportEntry({
							...entry,
							unit: redact(entry.unit),
							message: redact(entry.message),
						}),
					),
				);
				if (!chunk) {
					incomplete = "size_limit";
					break;
				}
				entries++;
				yield chunk;
			}
			incomplete ??= stopped();
			if (incomplete || result.hasMore === false) break;
			position = { ...query, continuation: result.continuation ?? undefined };
		}
	} catch (error) {
		if (!(error instanceof JournalReadError)) throw error;
		incomplete = stopped() ?? error.code;
	}
	yield encoder.encode(
		incomplete
			? `# incomplete: ${incomplete}\n`
			: `# complete: ${entries} entries\n`,
	);
}
