import type { LogStorage } from "@ceraui/rpc/schemas";

export const MIB = 1024 * 1024;

export function logStorage(overrides: Partial<LogStorage> = {}): LogStorage {
	return {
		journalBytes: 48 * MIB,
		journalDirBytes: 48 * MIB,
		legacyDebugBytes: 0,
		ceiling: { maxSizeMb: 256, maxAgeDays: 30 },
		retention: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
		oldestEntryTs: Date.UTC(2026, 10, 1, 8, 30),
		recentVolume: [
			{ source: "network", entries: 900, bytes: 90_000 },
			{ source: "app", entries: 2400, bytes: 300_000 },
			{ source: null, entries: 12, bytes: 10_000 },
		],
		recentSample: 3312,
		eventsBytes: 18_432,
		lastMaintenance: null,
		lastClearedAt: null,
		...overrides,
	};
}
