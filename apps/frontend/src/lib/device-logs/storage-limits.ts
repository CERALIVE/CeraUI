/**
 * The retention choices of the System Logs Storage form. Every offered limit
 * stays inside the device's own ceiling. A saved limit the ceiling does not
 * allow (or any limit under an unknown ceiling) is shown, and saved, as the
 * device limit: that is what journald enforces then, and the backend refuses a
 * non-null limit it cannot check.
 */
import type { LogRetention, LogStorage } from "@ceraui/rpc/schemas";

const KEEP_FOR_DAYS = [3, 7, 14];
const MAX_SIZE_MB = [32, 64, 128];
const DEVICE_LIMIT = "device";

export function keepForOptions(ceilingDays: number): number[] {
	return [...new Set([...KEEP_FOR_DAYS, ceilingDays])].filter(
		(days) => days <= ceilingDays,
	);
}

export function maxSizeOptions(ceilingMb: number): number[] {
	return MAX_SIZE_MB.filter((mb) => mb <= ceilingMb);
}

function withinCeiling(
	limit: number | null,
	ceiling: number | undefined,
): number | null {
	return limit !== null && ceiling !== undefined && limit <= ceiling
		? limit
		: null;
}

export function retentionDraft({
	retention,
	ceiling,
}: Pick<LogStorage, "retention" | "ceiling">): LogRetention {
	return {
		maxAgeDays: withinCeiling(retention.maxAgeDays, ceiling?.maxAgeDays),
		maxSizeMb: withinCeiling(retention.maxSizeMb, ceiling?.maxSizeMb),
		detail: retention.detail,
	};
}

export function sameRetention(a: LogRetention, b: LogRetention): boolean {
	return (
		a.maxAgeDays === b.maxAgeDays &&
		a.maxSizeMb === b.maxSizeMb &&
		a.detail === b.detail
	);
}

export function limitValue(limit: number | null): string {
	return limit === null ? DEVICE_LIMIT : String(limit);
}

export function limitFromValue(value: string): number | null {
	return value === DEVICE_LIMIT ? null : Number(value);
}
