/**
 * Boot list fixtures shaped exactly like `logs.boots()` replies: newest first
 * (journal index descending), journal-form boot ids.
 */
import type { LogBootInfo, VersionContext } from "@ceraui/rpc/schemas";

export const BOOT_IDS = {
	current: "a".repeat(32),
	clean: "b".repeat(32),
	unclean: "c".repeat(32),
	unknown: "d".repeat(32),
} as const;

export function versions(
	bootId: string,
	osImage: string | null,
	slot: string | null,
): VersionContext {
	return {
		bootId,
		osImage,
		slot,
		board: "rock-5b-plus",
		boardModel: null,
		ceraui: "2026.11.3",
		engine: null,
		senderVersion: null,
		kernel: null,
		bun: null,
	};
}

export function boot(
	bootId: string,
	shutdown: LogBootInfo["shutdown"],
	extra: Partial<LogBootInfo> = {},
): LogBootInfo {
	return {
		bootId,
		index: 0,
		firstTs: Date.UTC(2026, 10, 16, 10, 31, 5),
		lastTs: Date.UTC(2026, 10, 16, 11, 2, 40),
		current: shutdown === "current",
		shutdown,
		evidence: [],
		logsAvailable: true,
		versions: versions(bootId, "2026.11.3", "a"),
		...extra,
	};
}

export function fourBoots(): LogBootInfo[] {
	const minute = 60_000;
	const start = Date.UTC(2026, 10, 16, 10, 31, 5);
	return [
		boot(BOOT_IDS.current, "current", { index: 0, firstTs: start }),
		boot(BOOT_IDS.clean, "clean", { index: -1, firstTs: start - 5 * minute }),
		boot(BOOT_IDS.unclean, "unclean", {
			index: -2,
			firstTs: start - 10 * minute,
		}),
		boot(BOOT_IDS.unknown, "unknown", {
			index: -3,
			firstTs: start - 15 * minute,
		}),
	];
}
