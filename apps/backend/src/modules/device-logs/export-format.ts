import type {
	LogBootInfo,
	LogEntry,
	VersionContext,
} from "@ceraui/rpc/schemas";
import type { ParsedQuery } from "./continuation.ts";
import { MIN_REDACTED_LENGTH } from "./redaction.ts";

export function exportFilename(bootId: string | null, at: number): string {
	const stamp = new Date(at)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
	return `ceralive-logs-${bootId?.slice(0, 8) ?? "all"}-${stamp}.txt`;
}

export type KnownMatch = (text: string) => {
	readonly text: string;
	readonly redactions: number;
};

/**
 * Names the kinds of held values too short to match. The line is generated
 * text, so it is checked as written (with its "# " prefix): if it happens to
 * match a held value, a line that names no kinds is used instead, and if that
 * matches too, the line is left out.
 */
function shortValuesLines(
	kinds: readonly string[],
	known: KnownMatch,
): string[] {
	if (kinds.length === 0) return [];
	const label = `not redacted, shorter than ${MIN_REDACTED_LENGTH} characters`;
	const line = [
		`${label}: ${kinds.join(", ")}`,
		`${label}: some held values`,
	].find((candidate) => known(`# ${candidate}`).redactions === 0);
	return line === undefined ? [] : [line];
}

/** Stands in for a whole header value whose serialized form held a credential. */
const REDACTED_HEADER_VALUE = JSON.stringify("[REDACTED]");

export function exportHeader(
	current: VersionContext,
	boots: readonly LogBootInfo[],
	query: ParsedQuery,
	at: number,
	/**
	 * Applied to the variable values only (versions, boot ids, filter values),
	 * never to the fixed labels, the warning or the JSON syntax around a value.
	 */
	known: KnownMatch = (text) => ({ text, redactions: 0 }),
	/**
	 * Kinds of held values too short to match, sent as they appear. Only the
	 * kinds are written, never a value.
	 */
	unredacted: readonly string[] = [],
): string {
	// Replace held values in a string, then check the serialized value again:
	// JSON escaping can turn other text into a held value (a line break becomes
	// a backslash and "n"). A value that still matches is replaced as a whole.
	const fallback =
		known(REDACTED_HEADER_VALUE).redactions === 0
			? REDACTED_HEADER_VALUE
			: '""';
	const value = (raw: string | number | null): string => {
		const serialized = JSON.stringify(
			typeof raw === "string" ? known(raw).text : raw,
		);
		const content =
			typeof raw === "string" ? serialized.slice(1, -1) : serialized;
		return known(content).redactions === 0 ? serialized : fallback;
	};
	const versionLines = (context: VersionContext) =>
		Object.entries(context).map(([key, raw]) => `${key}: ${value(raw)}`);
	const array = (values: readonly string[]) => {
		const serialized = `[${[...new Set(values)].sort().map(value).join(",")}]`;
		return known(serialized).redactions === 0 ? serialized : fallback;
	};
	const filter = [
		`"sources":${array(query.sources)}`,
		`"levels":${array(query.levels)}`,
		...(query.text === undefined ? [] : [`"text":${value(query.text)}`]),
		...(query.since === undefined ? [] : [`"since":${value(query.since)}`]),
		...(query.until === undefined ? [] : [`"until":${value(query.until)}`]),
	];
	const lines = [
		"exported-by",
		...versionLines(current),
		...boots.flatMap((boot) => [
			`boot ${known(boot.bootId).text}`,
			...(boot.versions
				? versionLines(boot.versions)
				: ["versions: not recorded"]),
		]),
		`filter: {${filter.join(",")}}`,
		`createdAt: ${known(new Date(at).toISOString()).text}`,
		"newest first",
		...shortValuesLines(unredacted, known),
		"may contain sensitive data: review before sharing",
	];
	return `${lines.map((line) => `# ${line}`).join("\n")}\n`;
}

export function exportEntry(entry: LogEntry): string {
	const message = entry.message.replace(/\r\n|\r|\n/g, "\n    ");
	if (entry.marker === "suppressed") return `# gap: ${message}\n`;
	return `${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase().padEnd(7)} ${entry.unit.replace(/[\r\n]/g, " ")}: ${message}\n`;
}
