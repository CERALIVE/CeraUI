/**
 * What the System Logs Storage readout shows. Unknown stays unknown: no usage
 * means no bar and no number, an unknown ceiling means no limit.
 */
import { type LogStorage, logStorageSchema } from "@ceraui/rpc/schemas";

import { retentionDraft } from "./storage-limits";

const MIB = 1024 * 1024;

/**
 * Line breaking for Storage copy in every language: Japanese breaks between
 * phrases, Korean and Chinese only between words (Chinese at the gaps
 * betweenWords marks), a word too long for its line still wraps instead of
 * overflowing, and no paragraph ends on a lone character.
 */
export const LINE_BREAKS =
	"[word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep wrap-break-word text-pretty";

/** A formatted size, day count or date never splits across lines. */
export function keepWhole(value: string): string;
export function keepWhole(value: string | undefined): string | undefined;
export function keepWhole(value: string | undefined): string | undefined {
	return value?.replaceAll(" ", "\u00a0");
}

/**
 * Chinese has no spaces, so a browser may wrap it between any two characters,
 * even inside a word. Under keep-all (LINE_BREAKS) it wraps only where this adds
 * a zero-width space: between two words of two or more characters, so a
 * one-character word stays with its neighbours and a number with its unit.
 * Every other language is returned as it is.
 */
export function betweenWords(text: string, locale: string): string {
	if (!locale.startsWith("zh")) return text;
	let marked = "";
	let previous: Intl.SegmentData | undefined;
	for (const part of new Intl.Segmenter(locale, {
		granularity: "word",
	}).segment(text)) {
		if (previous && standsAlone(previous) && standsAlone(part))
			marked += "\u200b";
		marked += part.segment;
		previous = part;
	}
	return marked;
}

/** A word a line may end or begin at: two or more characters and no digit. */
function standsAlone(part: Intl.SegmentData): boolean {
	return (
		part.isWordLike === true &&
		[...part.segment].length > 1 &&
		!/\d/.test(part.segment)
	);
}

export interface UsageReadout {
	readonly used: number | null;
	readonly limit: number | null;
	readonly percent: number | null;
}

export type VolumeRow = LogStorage["recentVolume"][number] & {
	readonly share: number;
};

export function usageReadout(
	storage: Pick<LogStorage, "journalBytes" | "ceiling" | "retention">,
): UsageReadout {
	const { journalBytes: used, ceiling } = storage;
	const limit =
		ceiling === null
			? null
			: (retentionDraft(storage).maxSizeMb ?? ceiling.maxSizeMb) * MIB;
	const percent =
		used === null || limit === null
			? null
			: Math.min(100, (used / limit) * 100);
	return { used, limit, percent };
}

export function onDiskTotal({
	journalBytes,
	journalDirBytes,
}: Pick<LogStorage, "journalBytes" | "journalDirBytes">): number | null {
	return journalBytes !== null &&
		journalDirBytes !== null &&
		journalDirBytes > journalBytes
		? journalDirBytes
		: null;
}

type SchemaIssue = NonNullable<
	ReturnType<typeof logStorageSchema.safeParse>["error"]
>["issues"][number];

/** One of this build's reply schemas, as parseReply uses it. */
interface ReplySchema<T> {
	safeParse(
		reply: unknown,
	):
		| { success: true; data: T }
		| { success: false; error: { issues: SchemaIssue[] } };
	parse(reply: unknown): T;
}

/**
 * Reads a reply against one of this build's schemas. A newer device may add
 * fields this build does not know: those are dropped, while every known field
 * must still be present and valid.
 */
export function parseReply<T>(schema: ReplySchema<T>, reply: unknown): T {
	const result = schema.safeParse(reply);
	if (result.success) return result.data;
	return schema.parse(
		result.error.issues.reduce(
			(value, issue) =>
				issue.code === "unrecognized_keys"
					? withoutKeys(value, issue.path, issue.keys)
					: value,
			reply,
		),
	);
}

/** Reads a storage reading, as every reply that carries one does. */
export function parseStorage(reply: unknown): LogStorage {
	return parseReply(logStorageSchema, reply);
}

/** A copy of `value` without `keys` on the object the schema reported at `path`. */
function withoutKeys(
	value: unknown,
	[head, ...rest]: readonly PropertyKey[],
	keys: readonly string[],
): unknown {
	// The schema reports unknown keys only on objects, so every node on `path` is one.
	const node = value as Record<PropertyKey, unknown>;
	if (head === undefined)
		return Object.fromEntries(
			Object.entries(node).filter(([key]) => !keys.includes(key)),
		);
	const copy = Array.isArray(node) ? [...node] : { ...node };
	return Object.assign(copy, { [head]: withoutKeys(node[head], rest, keys) });
}

export function volumeRows(volume: LogStorage["recentVolume"]): VolumeRow[] {
	const total = volume.reduce((sum, row) => sum + row.bytes, 0);
	return volume
		.map((row) => ({
			...row,
			share: total === 0 ? 0 : (row.bytes / total) * 100,
		}))
		.sort((a, b) => b.bytes - a.bytes);
}
