import { collectVersionContext } from "../system/version-context.ts";
import { listBoots } from "./boots.ts";
import type { ParsedQuery } from "./continuation.ts";
import { exportHeader } from "./export-format.ts";
import { exportCredentialPolicy } from "./export-redaction.ts";
import { withQuerySlot } from "./query-admission.ts";
import { JournalReadError } from "./reader.ts";
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
	const policy = exportCredentialPolicy();
	const unavailable = () =>
		stopped() ?? (policy.ok && policy.changed() ? "CREDENTIALS_CHANGED" : null);
	let incomplete: string | null = stopped();
	if (!policy.ok) incomplete ??= policy.footer ?? policy.error;
	try {
		if (!incomplete && policy.ok) {
			const boots = await listBoots();
			const covered =
				bootId === null
					? boots
					: boots.filter((boot) => boot.bootId === bootId);
			if (bootId !== null && !covered.some((boot) => boot.logsAvailable)) {
				incomplete = "BOOT_UNAVAILABLE";
			}
			const current = await collectVersionContext();
			incomplete ??= unavailable();
			if (!incomplete) {
				const header = encode(
					exportHeader(
						current,
						covered,
						query,
						createdAt,
						policy.known,
						policy.unredacted,
					),
				);
				if (header) yield header;
				else incomplete = "size_limit";
			}
		}
		let position = query;
		while (!incomplete && policy.ok) {
			incomplete = unavailable();
			if (incomplete) break;
			const result = await withQuerySlot(
				owner,
				(slotSignal) =>
					scanPage(position, {
						bootId,
						epoch,
						signal: AbortSignal.any([slotSignal, signal]),
						project: policy.project,
					}),
				signal,
			);
			incomplete = unavailable();
			if (incomplete) break;
			if (!result.ok) {
				incomplete = result.error;
				break;
			}
			for (const entry of result.entries) {
				incomplete = unavailable();
				if (incomplete) break;
				const chunk = encode(policy.format(entry));
				if (!chunk) {
					incomplete = "size_limit";
					break;
				}
				entries++;
				yield chunk;
			}
			incomplete ??= unavailable();
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
