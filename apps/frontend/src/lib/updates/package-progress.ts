import type { UpdateProgress } from "@ceraui/rpc/schemas";

export function packageProgressFraction(
	progress: UpdateProgress,
	succeeded = false,
) {
	const total = 3 * progress.total;
	if (!Number.isSafeInteger(total) || total <= 0) return null;
	const parsed =
		progress.downloading + progress.unpacking + progress.setting_up;
	// Dpkg can report its last setup while APT is still running or about to fail.
	const completed = succeeded
		? total
		: Math.max(0, Math.min(total - 1, parsed));
	if (!Number.isFinite(completed)) return null;
	return { completed, total, percent: Math.floor((100 * completed) / total) };
}
