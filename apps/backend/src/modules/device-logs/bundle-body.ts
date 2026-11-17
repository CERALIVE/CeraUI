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
type Section = LogBundleManifest["sections"][number]["id"];

export async function buildBundle(
	signal: AbortSignal,
	createdAt: number,
	epoch: number,
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
	const manifest = logBundleManifestSchema.parse({
		sections: ["versions", "settings", "events", "journal"].map((id) => ({
			id,
			entries: 0,
			redactions: 0,
		})),
		exportedBy: snapshot.exportedBy,
		boots: snapshot.boots,
	});
	const chunks: Uint8Array[] = [];
	let plainBytes = 0;
	let compressedBytes = 0;
	const stopped = () => {
		if (getLogState().historyEpoch !== epoch) throw new BundleReadError();
		if (signal.aborted && signal.reason !== "time_limit")
			throw new BundleReadError();
		return signal.aborted || Date.now() - createdAt >= 60_000
			? "time_limit"
			: null;
	};
	async function append(
		section: Section | "end",
		payload: Record<string, unknown>,
		terminal = false,
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
		if (!terminal && plainBytes + bytes.byteLength > MAX_PLAIN - TAIL_RESERVE)
			return "size_limit";
		// Complete gzip members let admission measure exact compressed bytes before
		// accepting each record; no raw body or device scratch file is retained.
		const zipped = new Uint8Array(
			await new Response(
				new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
			).arrayBuffer(),
		);
		if (
			!terminal &&
			compressedBytes + zipped.byteLength > MAX_COMPRESSED - TAIL_RESERVE
		)
			return "compressed_size_limit";
		plainBytes += bytes.byteLength;
		compressedBytes += zipped.byteLength;
		if (keep) chunks.push(zipped);
		if (!terminal) {
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
	for (const boot of snapshot.journalBoots) {
		if (incomplete) break;
		const query = logQueryInputSchema.parse({
			boot,
			direction: "older",
			limit: 200,
		});
		let position = query;
		while (!incomplete) {
			incomplete = stopped();
			if (incomplete) break;
			try {
				const page = await withQuerySlot(owner, (slotSignal) =>
					scanPage(position, {
						bootId: boot,
						epoch,
						signal: AbortSignal.any([signal, slotSignal]),
					}),
				);
				incomplete = stopped();
				if (incomplete) break;
				if (!page.ok) {
					incomplete = page.error;
					break;
				}
				for (const entry of page.entries) {
					incomplete = stopped() ?? (await append("journal", { entry }));
					if (incomplete) break;
				}
				if (page.hasMore === false) break;
				position = { ...query, continuation: page.continuation ?? undefined };
			} catch (error) {
				if (error instanceof BundleReadError) throw error;
				incomplete = stopped() ?? "READ_FAILED";
			}
		}
	}
	incomplete ??= stopped();
	if (incomplete) await append("journal", { incomplete }, true);
	await append("end", { complete: incomplete === null }, true);
	const late = stopped();
	if (incomplete === null && late !== null) {
		incomplete = late;
		chunks.pop();
		await append("journal", { incomplete }, true);
		await append("end", { complete: false }, true);
	}
	redactor.structured(JSON.stringify(manifest));
	return { manifest, chunks, filename };
}
