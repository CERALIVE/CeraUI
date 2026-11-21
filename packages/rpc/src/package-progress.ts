import type { UpdateProgress } from './schemas/system.schema';

export function packageProgressFraction(progress: UpdateProgress, succeeded = false) {
	if (!succeeded && progress.unpacking === 0 && progress.setting_up === 0) return null;
	const total = 3 * progress.total;
	if (!Number.isSafeInteger(total) || total <= 0) return null;
	const started = progress.downloading + progress.unpacking + progress.setting_up;
	// The latest dpkg record only proves a start. Credit that step at the
	// next start, or credit the full transaction on a successful exit.
	const completed = succeeded ? total : Math.max(0, Math.min(total - 1, started - 1));
	if (!Number.isFinite(completed)) return null;
	return { completed, total, percent: Math.floor((100 * completed) / total) };
}
