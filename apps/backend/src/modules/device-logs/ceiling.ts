import { readFileSync } from "node:fs";
import type { LogStorage } from "@ceraui/rpc/schemas";

const seconds: Readonly<Record<string, number>> = {
	"": 1,
	s: 1,
	min: 60,
	h: 3600,
	d: 86400,
	day: 86400,
	days: 86400,
	w: 604800,
	week: 604800,
	weeks: 604800,
	month: 2629800,
	months: 2629800,
	y: 31557600,
	year: 31557600,
};

export function readJournalCeiling(
	path = "/etc/systemd/journald.conf.d/10-ceralive-journal.conf",
): LogStorage["ceiling"] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let journal = false;
	let size = "";
	let age = "";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) journal = line === "[Journal]";
		if (!journal) continue;
		const setting = /^(SystemMaxUse|MaxRetentionSec)\s*=\s*(.*)$/.exec(line);
		if (setting?.[1] === "SystemMaxUse") size = setting[2] ?? "";
		if (setting?.[1] === "MaxRetentionSec") age = setting[2] ?? "";
	}
	const sizeMatch = /^(\d+)([KMG])$/.exec(size);
	const ageMatch =
		/^(\d+)\s*(s|min|h|d|day|days|w|week|weeks|month|months|y|year)?$/.exec(
			age,
		);
	if (!sizeMatch || !ageMatch) return null;
	const sizeFactor = { K: 1 / 1024, M: 1, G: 1024 }[sizeMatch[2] ?? ""];
	const ageFactor = seconds[ageMatch[2] ?? ""];
	if (sizeFactor === undefined || ageFactor === undefined) return null;
	const maxSizeMb = Number(sizeMatch[1]) * sizeFactor;
	const duration = Number(ageMatch[1]) * ageFactor;
	const maxAgeDays = Math.floor(duration / 86400);
	if (
		!Number.isSafeInteger(maxSizeMb) ||
		maxSizeMb <= 0 ||
		!Number.isSafeInteger(duration) ||
		maxAgeDays <= 0
	)
		return null;
	return { maxSizeMb, maxAgeDays };
}

export function parseDiskUsage(text: string): number | null {
	const match = /take up (\d+(?:\.\d+)?)\s*([BKMGT])\b/.exec(text);
	if (!match) return null;
	const bytes = Number(match[1]) * 1024 ** "BKMGT".indexOf(match[2] ?? "");
	return Number.isFinite(bytes) && bytes <= Number.MAX_SAFE_INTEGER
		? bytes
		: null;
}
