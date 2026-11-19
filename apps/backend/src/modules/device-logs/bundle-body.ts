import {
	type LogBundleManifest,
	logBundleManifestSchema,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { collectBundleData } from "./bundle-data.ts";
import { withQuerySlot } from "./query-admission.ts";
import { BundleReadError, buildRedactor } from "./redaction.ts";
import { scanPage } from "./scan-page.ts";
import { getLogState } from "./settings.ts";

const MAX_PLAIN = 32 * 1024 * 1024;
const MAX_COMPRESSED = 8 * 1024 * 1024;
const TAIL_RESERVE = 512;
export const BUNDLE_TIME_MS = 60_000;
type Section = LogBundleManifest["sections"][number]["id"];

export async function buildBundle(
	{
		signal,
		createdAt,
		epoch,
	}: {
		readonly signal: AbortSignal;
		readonly createdAt: number;
		readonly epoch: number;
	},
	keep: boolean,
): Promise<{
	readonly manifest: LogBundleManifest;
	readonly chunks: readonly Uint8Array[];
	readonly filename: string;
}> {
	const snapshot = await collectBundleData();
	const redactor = buildRedactor(snapshot.secrets);
	redactor.structured(createdAt);
	const filename = `ceralive-support-${snapshot.exportedBy.bootId.slice(0, 8)}-${new Date(
		createdAt,
	)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z")}.ndjson.gz`;
	redactor.structured(filename);
	const counts = { entries: 0, redactions: 0 };
	const journal: Extract<
		LogBundleManifest["sections"][number],
		{ id: "journal" }
	> = { id: "journal", ...counts, bootsCovered: 0, complete: false };
	const manifest: LogBundleManifest = {
		sections: [
			{ id: "versions", ...counts },
			{ id: "settings", ...counts },
			{ id: "events", ...counts },
			journal,
		],
		exportedBy: snapshot.exportedBy,
		boots: [...snapshot.boots],
	};
	const chunks: Uint8Array[] = [];
	let plainBytes = 0;
	let compressedBytes = 0;
	const stopped = () => {
		if (getLogState().historyEpoch !== epoch) throw new BundleReadError();
		if (signal.aborted && signal.reason !== "time_limit")
			throw new BundleReadError();
		return signal.aborted || Date.now() - createdAt >= BUNDLE_TIME_MS
			? "time_limit"
			: null;
	};
	const totalBudget = {
		plain: MAX_PLAIN - TAIL_RESERVE,
		compressed: MAX_COMPRESSED - TAIL_RESERVE,
	};
	async function append(
		section: Section | "end",
		payload: Record<string, unknown>,
		budget: typeof totalBudget | null = totalBudget,
	) {
		let redactions = 0;
		function visit(value: unknown, message = false): unknown {
			if (typeof value === "string") {
				const masked = redactor.text(value);
				if (!message && masked.redactions !== 0) throw new BundleReadError();
				redactions += masked.redactions;
				return masked.text;
			}
			if (
				typeof value === "number" ||
				typeof value === "boolean" ||
				value === null
			) {
				redactor.structured(value);
				return value;
			}
			if (Array.isArray(value))
				return value.map((item: unknown) => visit(item));
			if (typeof value !== "object") throw new BundleReadError();
			return Object.fromEntries(
				Object.entries(value).map(([key, inner]) => {
					if (redactor.text(key).redactions !== 0) throw new BundleReadError();
					return [
						key,
						visit(inner, section === "journal" && key === "message"),
					];
				}),
			);
		}
		const text = `${JSON.stringify(visit({ section, ...payload }))}\n`;
		redactor.structured(text);
		const bytes = new TextEncoder().encode(text);
		if (budget && plainBytes + bytes.byteLength > budget.plain)
			return "size_limit";
		// Complete gzip members let admission measure exact compressed bytes before
		// accepting each record; no raw body or device scratch file is retained.
		const zipped = new Uint8Array(
			await new Response(
				new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
			).arrayBuffer(),
		);
		if (budget && compressedBytes + zipped.byteLength > budget.compressed)
			return "compressed_size_limit";
		plainBytes += bytes.byteLength;
		compressedBytes += zipped.byteLength;
		if (keep) chunks.push(zipped);
		if (budget) {
			const counter = manifest.sections.find((entry) => entry.id === section);
			if (counter) {
				counter.entries++;
				counter.redactions += redactions;
			}
		}
		return null;
	}
	const prelude: Array<readonly [Section, Record<string, unknown>]> = [
		["versions", { exportedBy: snapshot.exportedBy }],
		...snapshot.boots.map((boot) => ["versions", boot] as const),
		["settings", snapshot.settings],
		...snapshot.events.map((event) => ["events", { event }] as const),
		...snapshot.bootRecords.map((boot) => ["events", { boot }] as const),
	];
	// The preview returns these structured fields even when the journal is cut.
	if (redactor.text(JSON.stringify(manifest)).redactions !== 0)
		throw new BundleReadError();
	let incomplete: string | null = null;
	for (const [section, payload] of prelude) {
		incomplete = stopped() ?? (await append(section, payload));
		if (incomplete) break;
	}
	const owner = {};
	const previousBudget = {
		plain: plainBytes + Math.floor((totalBudget.plain - plainBytes) / 2),
		compressed:
			compressedBytes +
			Math.floor((totalBudget.compressed - compressedBytes) / 2),
	};
	for (const boot of incomplete ? [] : [...snapshot.journalBoots].reverse()) {
		const budget =
			boot === snapshot.exportedBy.bootId ? totalBudget : previousBudget;
		const startingEntries = journal.entries;
		let bootIncomplete: string | null = null;
		const query = logQueryInputSchema.parse({
			boot,
			direction: "older",
			limit: 200,
		});
		let position = query;
		while (!bootIncomplete) {
			bootIncomplete = stopped();
			if (bootIncomplete) break;
			try {
				const page = await withQuerySlot(
					owner,
					(slotSignal) =>
						scanPage(position, {
							bootId: boot,
							epoch,
							signal: AbortSignal.any([signal, slotSignal]),
						}),
					signal,
				);
				bootIncomplete = stopped();
				if (bootIncomplete) break;
				if (!page.ok) {
					bootIncomplete = page.error;
					break;
				}
				for (const entry of page.entries) {
					bootIncomplete =
						stopped() ?? (await append("journal", { entry }, budget));
					if (bootIncomplete) break;
				}
				if (page.hasMore === false) break;
				position = { ...query, continuation: page.continuation ?? undefined };
			} catch (error) {
				if (error instanceof BundleReadError) throw error;
				bootIncomplete = stopped() ?? "READ_FAILED";
			}
		}
		if (journal.entries > startingEntries) journal.bootsCovered++;
		incomplete ??= bootIncomplete;
	}
	incomplete ??= stopped();
	if (incomplete) await append("journal", { incomplete }, null);
	await append("end", { complete: incomplete === null }, null);
	const late = stopped();
	if (incomplete === null && late !== null) {
		incomplete = late;
		chunks.pop();
		await append("journal", { incomplete }, null);
		await append("end", { complete: false }, null);
	}
	journal.complete = incomplete === null;
	const output = logBundleManifestSchema.parse(manifest);
	redactor.structured(JSON.stringify(output));
	return { manifest: output, chunks, filename };
}
