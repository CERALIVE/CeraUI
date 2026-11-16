import { createRawSnippet, mount, type Snippet, unmount } from "svelte";

import ViewLogsAction from "$lib/components/custom/ViewLogsAction.svelte";
import type { ActiveNotification } from "$lib/stores/notifications.svelte";
import KeepWords from "../../main/system-logs/KeepWords.svelte";
import { LOG_POINTER_KEYS, notificationLogKey } from "./log-pointer-keys";
import { VIEW_LOGS_TOAST_CLASS } from "./view-logs";

/** The toast's fixed translated copy uses the same CJK word boundaries as the notice. */
export function viewLogsMessage(
	notification: Pick<ActiveNotification, "key" | "params" | "text">,
): string | Snippet {
	if (!LOG_POINTER_KEYS.has(notificationLogKey(notification)))
		return notification.text;
	return createRawSnippet(() => ({
		render: () => "<span></span>",
		setup(target) {
			const text = mount(KeepWords, {
				target,
				props: { text: notification.text },
			});
			return () => {
				void unmount(text);
			};
		},
	}));
}

// Sonner's ordinary cancel action ignores clicks on non-dismissible notices.
export function viewLogsSecondary(
	notification: Pick<ActiveNotification, "key" | "params" | "receivedAt">,
	onViewLogs: () => void,
): { cancel: Snippet; class: string } | undefined {
	const messageKey = notificationLogKey(notification);
	if (!LOG_POINTER_KEYS.has(messageKey)) return undefined;
	return {
		class: VIEW_LOGS_TOAST_CLASS,
		cancel: createRawSnippet(() => ({
			render: () => "<span></span>",
			setup(target) {
				const action = mount(ViewLogsAction, {
					target,
					props: { messageKey, at: notification.receivedAt, onViewLogs },
				});
				return () => {
					void unmount(action);
				};
			},
		})),
	};
}
