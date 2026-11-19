/**
 * The messages whose English text sends the operator to Settings → System Logs,
 * and so render a "View logs" action beside them. `log-pointer-keys.test.ts`
 * derives this set from the catalog and asserts equality.
 */
import type { Notification } from "@ceraui/rpc/schemas";

import {
	UPDATE_REFUSED_NOTICE_KEY,
	updateRefusalReasonKey,
} from "../updates/update-refusal-notice";

// Typed to accept an absent key, which is simply not a member.
export const LOG_POINTER_KEYS: ReadonlySet<string | undefined> = new Set([
	"live.encoder.applyPhase.reasonUnknown",
	"live.startFailure.notRetriable",
	"live.startFailure.retriedThenFailed",
	"network.modem.refusal.writeFailed",
	"network.modem.usbMode.reason.transaction_error",
	"notifications.streamAutostartNoLinksFailed",
	"notifications.streamRecoveryFailed",
	"notifications.streamStartEngineRestartingFailed",
	"notifications.streamStartEngineUnavailableFailed",
	"notifications.streamStartInternalFailed",
	"notifications.streamStartInvalidFailed",
	"notifications.streamStartProtocolFailed",
	"notifications.streamStartTimeoutFailed",
	"notifications.updateRefusedGeneric",
	"settings.updates.cleanup_warning.post_clean_failed",
	"settings.updates.credentials.rejectedBody",
	"settings.updates.failedReasonGeneric",
	"settings.updates.kernel.reason.generic",
	"settings.updates.refusal.generic",
	"settings.updates.update_preflight_failed.apt_config_failed",
	"settings.updates.update_preflight_failed.archive_path_invalid",
	"settings.updates.update_preflight_failed.insufficient_space",
	"settings.updates.update_preflight_failed.pre_clean_failed",
	"settings.updates.update_preflight_failed.stat_failed",
	"settings.updates.update_preflight_failed.statfs_failed",
	"settings.updates.update_preflight_failed.value_out_of_range",
]);

/** The key a notification's text comes from; a refusal reads as its reason's sentence. */
export function notificationLogKey(
	notification: Pick<Notification, "key" | "params">,
): string | undefined {
	return notification.key === UPDATE_REFUSED_NOTICE_KEY
		? updateRefusalReasonKey(notification.params?.reason)
		: notification.key;
}
