import { credentialStoresState } from "../../helpers/credential-store-state.ts";
import { collectVersionContext } from "../system/version-context.ts";
import { listBoots } from "./boots.ts";
import { collectHeldSecrets } from "./bundle-data.ts";
import type { ParsedQuery } from "./continuation.ts";
import { exportEntry, exportHeader } from "./export-format.ts";
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
	// done for every held credential, nothing but the footer is sent. The limits
	// (a snapshot, after journal normalization, fixed footer and filename text)
	// are in docs/agents/device-log-export.md.
	let redact = (text: string) => text;
	const stores = credentialStoresState();
	if (stores === "pending") {
		incomplete ??= "CREDENTIALS_LOADING";
	} else if (stores === "failed") {
		incomplete ??= "READ_FAILED";
	} else {
		try {
			const redactor = buildRedactor(collectHeldSecrets());
			if (redactor.unredacted.length > 0) {
				// Too short to match safely: refuse rather than send them.
				incomplete ??= `CREDENTIAL_TOO_SHORT (${redactor.unredacted.join(", ")})`;
			} else {
				redact = (text) => redactor.known(text).text;
			}
		} catch {
			incomplete ??= "READ_FAILED";
		}
	}
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
					exportHeader(current, covered, query, createdAt, redact),
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
