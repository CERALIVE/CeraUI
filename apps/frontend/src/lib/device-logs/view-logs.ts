import { m } from "@ceraui/i18n/svelte";

import { requestDialog } from "$lib/stores/dialog-request.svelte";

import { LOG_POINTER_KEYS } from "./log-pointer-keys";

// Sonner's own action is not a house Button, so lift only these toast actions.
export const VIEW_LOGS_TOAST_CLASS =
	"flex-wrap gap-2! [&>[data-content]]:basis-3/4! [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep [&_[data-content]]:text-pretty [&_[data-button]]:min-h-(--touch-target-min) [&_[data-button]]:border! [&_[data-button]]:border-border! [&_[data-button]]:bg-background! [&_[data-button]]:text-foreground! [&_[data-button]]:hover:bg-accent! [&_[data-button]]:focus-visible:ring-3";

/** Open System Logs on Raw logs around `at`: the message's time when known, else now. */
export function viewLogs(at: number = Date.now()): void {
	requestDialog("logs", { tab: "raw", at });
}

/** Toast options carrying View logs when `key` names a log-pointing message; `at` defaults to when the toast is raised. */
export function viewLogsToast(
	key: string | undefined,
	at: number = Date.now(),
):
	| { action: { label: string; onClick: () => void }; class: string }
	| undefined {
	if (!LOG_POINTER_KEYS.has(key)) return undefined;
	return {
		class: VIEW_LOGS_TOAST_CLASS,
		action: {
			label: m["notifications.viewLogs"](),
			onClick: () => viewLogs(at),
		},
	};
}
