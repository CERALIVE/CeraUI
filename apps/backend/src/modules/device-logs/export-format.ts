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

export function exportHeader(
	current: VersionContext,
	boots: readonly LogBootInfo[],
	query: ParsedQuery,
	at: number,
): string {
	const versionLines = (context: VersionContext) =>
		Object.entries(context).map(
			([key, value]) => `${key}: ${JSON.stringify(value)}`,
		);
	const lines = [
		"exported-by",
		...versionLines(current),
		...boots.flatMap((boot) => [
			`boot ${boot.bootId}`,
			...(boot.versions
				? versionLines(boot.versions)
				: ["versions: not recorded"]),
		]),
		`filter: ${JSON.stringify({
			sources: [...new Set(query.sources)].sort(),
			levels: [...new Set(query.levels)].sort(),
			text: query.text,
			since: query.since,
			until: query.until,
		})}`,
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
