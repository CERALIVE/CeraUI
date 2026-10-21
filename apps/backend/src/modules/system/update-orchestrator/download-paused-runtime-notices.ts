import { logger } from "../../../helpers/logger.ts";
import { DownloadPausedLedger } from "./download-paused-ledger.ts";
import { DownloadPausedNotices } from "./download-paused-notices.ts";
import { clearUpdateNotice, notifyUpdate } from "./notifications.ts";

function productionNotices(): DownloadPausedNotices {
	return new DownloadPausedNotices({
		ledger: new DownloadPausedLedger(),
		publish: (fact, onDismiss) => {
			notifyUpdate({ kind: "download-paused", id: fact.id }, { onDismiss });
		},
		clear: (id) => clearUpdateNotice("download-paused", id),
		report: (reason) =>
			logger.warn("update-orchestrator: download hold notice deferred", {
				reason,
			}),
	});
}

let notices = productionNotices();
export function downloadPausedNotices(): DownloadPausedNotices {
	return notices;
}
export function setDownloadPausedNoticesForTest(
	next?: DownloadPausedNotices,
): void {
	notices.dispose();
	notices = next ?? productionNotices();
}
