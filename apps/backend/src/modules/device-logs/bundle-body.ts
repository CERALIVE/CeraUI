import {
	type LogBundleManifest,
	type LogEntry,
	logBundleManifestSchema,
} from "@ceraui/rpc/schemas";
import { collectBundleData } from "./bundle-data.ts";
import { collectBundleJournal } from "./bundle-journal.ts";
import { BundleReadError, buildRedactor } from "./redaction.ts";
import { getLogState } from "./settings.ts";

const MAX_PLAIN = 32 * 1024 * 1024;
const MAX_COMPRESSED = 8 * 1024 * 1024;
const TAIL_RESERVE = 512;
export const BUNDLE_TIME_MS = 60_000;
type Section = LogBundleManifest["sections"][number]["id"];
// sd_journal_get_cursor's exact format: journald's own hex counters, hashes and IDs.
const NATIVE_CURSOR =
	/^s=[0-9a-f]{32};i=[0-9a-f]{1,16};b=([0-9a-f]{32});m=[0-9a-f]{1,16};t=[0-9a-f]{1,16};x=[0-9a-f]{1,16}$/;

function bootSpan(
	value: unknown,
	expected: string | undefined,
	inCursor: boolean,
): readonly [number, number] | undefined {
	if (!expected || !/^[0-9a-f]{32}$/.test(expected)) return;
	if (!inCursor) return value === expected ? [0, expected.length] : undefined;
	if (typeof value !== "string") return;
	// Such a cursor carries no caller text, so a digit run in its hash is no identifier.
	if (NATIVE_CURSOR.exec(value)?.[1] === expected) return [0, value.length];
	const [boot, duplicate] = value.matchAll(/(?:^|;)b=([^;]*)/g);
	if (!boot || duplicate || boot[1] !== expected) return;
	const end = boot.index + boot[0].length;
	return [end - expected.length, end];
}

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
	// Register the objects that own boot identity fields, never arbitrary values.
	const bootFields = new WeakMap<object, string>();
	const current = snapshot.journalBoots[0];
	if (current) bootFields.set(snapshot.exportedBy, current);
	for (const boot of snapshot.boots) {
		if (!snapshot.journalBoots.includes(boot.bootId)) continue;
		bootFields.set(boot, boot.bootId);
		if (boot.versions) bootFields.set(boot.versions, boot.bootId);
	}
	for (const boot of snapshot.bootRecords) {
		bootFields.set(boot, boot.bootId);
		if (boot.versions) bootFields.set(boot.versions, boot.bootId);
	}
	const knownBoots = new Set([
		...snapshot.journalBoots,
		...snapshot.bootRecords.map((boot) => boot.bootId),
	]);
	for (const event of snapshot.events) {
		if (knownBoots.has(event.bootId)) bootFields.set(event, event.bootId);
		// device_started and previous_boot_unclean name the boot before theirs.
		const named = event.params.previousBootId ?? event.params.bootId;
		if (typeof named === "string" && knownBoots.has(named))
			bootFields.set(event.params, named);
	}
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
		if (getLogState().historyEpoch !== epoch)
			throw new BundleReadError("abort");
		if (signal.aborted && signal.reason !== "time_limit")
			throw new BundleReadError("abort");
		return signal.aborted || Date.now() - createdAt >= BUNDLE_TIME_MS
			? "time_limit"
			: null;
	};
	const totalBudget = {
		plain: MAX_PLAIN - TAIL_RESERVE,
		compressed: MAX_COMPRESSED - TAIL_RESERVE,
	};
	function inspect(root: unknown, entry?: LogEntry) {
		let redactions = 0;
		function visit(
			value: unknown,
			message = false,
			span?: ReturnType<typeof bootSpan>,
		): unknown {
			if (typeof value === "string") {
				// A held secret refuses first, so any remaining mask is a pattern.
				if (!message) redactor.structured(value);
				const masked = redactor.text(value, span);
				if (!message && masked.redactions !== 0)
					throw new BundleReadError("pattern");
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
					redactor.structured(key);
					if (redactor.text(key).redactions !== 0)
						throw new BundleReadError("pattern");
					const cursor = value === entry && key === "cursor";
					const span =
						key === "bootId" || key === "previousBootId" || cursor
							? bootSpan(inner, bootFields.get(value), cursor)
							: undefined;
					return [
						key,
						visit(inner, value === entry && key === "message", span),
					];
				}),
			);
		}
		const text = JSON.stringify(visit(root));
		return { text, redactions };
	}
	async function append(
		section: Section | "end",
		payload: Record<string, unknown>,
		budget: typeof totalBudget | null = totalBudget,
		entry?: LogEntry,
	) {
		const record = { section, ...payload };
		const boot = bootFields.get(payload);
		if (boot) bootFields.set(record, boot);
		const inspected = inspect(record, entry);
		const text = `${inspected.text}\n`;
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
				counter.redactions += inspected.redactions;
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
	redactor.structured(inspect(manifest).text);
	let incomplete: string | null = null;
	for (const [section, payload] of prelude) {
		incomplete = stopped() ?? (await append(section, payload));
		if (incomplete) break;
	}
	const previousBudget = {
		plain: plainBytes + Math.floor((totalBudget.plain - plainBytes) / 2),
		compressed:
			compressedBytes +
			Math.floor((totalBudget.compressed - compressedBytes) / 2),
	};
	if (incomplete === null) {
		const coverage = await collectBundleJournal(
			snapshot.journalBoots,
			{ epoch, signal, stopped, deadline: createdAt + BUNDLE_TIME_MS },
			(entry, isCurrent, boot) => {
				if (entry.bootId === boot) bootFields.set(entry, boot);
				return append(
					"journal",
					{ entry },
					isCurrent ? totalBudget : previousBudget,
					entry,
				);
			},
		);
		incomplete = coverage.incomplete;
		journal.bootsCovered = coverage.bootsCovered;
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
