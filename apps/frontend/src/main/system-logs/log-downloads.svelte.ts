import { requestLegacyLog } from "$lib/device-logs/download-gate";
import { getDeviceLog, getSystemLog } from "$lib/helpers/SystemHelper";

export type LogKind = "device" | "system";

/**
 * The two shipped downloads' in-flight and failed state. SystemLogsView owns one
 * per open view, so a failed download keeps its retry band while the Downloads
 * region remounts across tabs, the availability check and the 1024 px breakpoint.
 */
export class LogDownloads {
	// In-flight + failure are surfaced INLINE (progress spinner on the row, calm
	// amber retry band below) rather than via a bare toast. A transient toast is
	// easy to miss and offers no recovery. The download is a single awaited request
	// with no backend progress events, so "progress" is the in-flight indicator.
	downloading = $state<LogKind | null>(null);
	failed = $state<LogKind | null>(null);
	readonly #current: () => boolean;

	/** `current`: whether the view that asks is still open, read as each download starts. */
	constructor(current: () => boolean) {
		this.#current = current;
	}

	async download(kind: LogKind): Promise<void> {
		if (this.downloading !== null || !this.#current()) return;
		this.downloading = kind;
		this.failed = null;
		try {
			await requestLegacyLog(
				this.#current,
				kind === "device" ? getDeviceLog : getSystemLog,
			);
		} catch (error) {
			console.error(`Failed to request ${kind} log:`, error);
			this.failed = kind;
		} finally {
			this.downloading = null;
		}
	}
}
