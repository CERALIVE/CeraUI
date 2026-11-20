import type {
	LogBootInfo,
	LogEntry,
	VersionContext,
} from "@ceraui/rpc/schemas";
import type { ParsedQuery } from "./continuation.ts";

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
): string {
	// Replace held values in a string, then check the serialized value again:
	// JSON escaping can turn other text into a held value (a line break becomes
	// a backslash and "n"). A value that still matches is replaced as a whole.
	const value = (raw: string | number | null): string => {
		const serialized = JSON.stringify(
			typeof raw === "string" ? known(raw).text : raw,
		);
		const content =
			typeof raw === "string" ? serialized.slice(1, -1) : serialized;
		return known(content).redactions === 0 ? serialized : REDACTED_HEADER_VALUE;
	};
	const versionLines = (context: VersionContext) =>
		Object.entries(context).map(([key, raw]) => `${key}: ${value(raw)}`);
	const filter = Object.entries({
		sources: [...new Set(query.sources)].sort(),
		levels: [...new Set(query.levels)].sort(),
		text: query.text,
		since: query.since,
		until: query.until,
	})
		.filter(([, raw]) => raw !== undefined)
		.map(
			([key, raw]) =>
				`${JSON.stringify(key)}:${Array.isArray(raw) ? `[${raw.map(value).join(",")}]` : value(raw as string | number)}`,
		);
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
		`createdAt: ${new Date(at).toISOString()}`,
		"newest first",
		"may contain sensitive data: review before sharing",
	];
	return `${lines.map((line) => `# ${line}`).join("\n")}\n`;
}

export function exportEntry(entry: LogEntry): string {
	const message = entry.message.replace(/\r\n|\r|\n/g, "\n    ");
	if (entry.marker === "suppressed") return `# gap: ${message}\n`;
	return `${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase().padEnd(7)} ${entry.unit.replace(/[\r\n]/g, " ")}: ${message}\n`;
}
