import { m } from "@ceraui/i18n/svelte";

import { requestDialog } from "$lib/stores/dialog-request.svelte";
import type { ActiveNotification } from "$lib/stores/notifications.svelte";

import { LOG_POINTER_KEYS } from "./log-pointer-keys";
import type { EventMatch } from "./raw-anchor";

// Sonner's own action is not a house Button, so lift only these toast actions.
export const VIEW_LOGS_TOAST_CLASS =
	"flex-wrap gap-2! [&>[data-content]]:basis-3/4! [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep [&_[data-content]]:text-pretty [&_[data-button]]:min-h-(--touch-target-min) [&_[data-button]]:border! [&_[data-button]]:border-border! [&_[data-button]]:bg-background! [&_[data-button]]:text-foreground! [&_[data-button]]:hover:bg-accent! [&_[data-button]]:focus-visible:ring-3";

/** Open System Logs on Raw logs around `at`: the message's time when known, else now. */
export function viewLogs(at: number = Date.now()): void {
	requestDialog("logs", { tab: "raw", at });
}

export type NoticeMoment = Pick<
	ActiveNotification,
	"name" | "receivedAt" | "arrivedLive"
>;

// Every update notice is named update:<kind>:<id> and emits the timeline event
// update_<kind> carrying that id (backend update-orchestrator/notifications.ts).
function updateEvent(name: string): EventMatch | undefined {
	const [, kind, id] = /^update:([^:]+):(.+)$/.exec(name) ?? [];
	if (kind === undefined || id === undefined) return undefined;
	return { family: "update", code: `update_${kind.replaceAll("-", "_")}`, id };
}

/** Open System Logs on Raw logs for a standing notice: its event's entry, else its live arrival, else the newest entries. */
export function viewNoticeLogs(notice: NoticeMoment): void {
	const event = updateEvent(notice.name);
	requestDialog("logs", {
		tab: "raw",
		...(notice.arrivedLive ? { at: notice.receivedAt } : {}),
		...(event === undefined ? {} : { event }),
		...(notice.arrivedLive || event !== undefined
			? {}
			: { momentUnknown: true as const }),
	});
}

/** The moment of a message that carries no time: the timeline event it emitted, or none known. */
export type LogMoment = { readonly event: EventMatch } | "unknown";

/** Open System Logs on Raw logs at a message's event entry, or at the newest entries saying its time is not known. */
export function viewMomentLogs(moment: LogMoment): void {
	requestDialog(
		"logs",
		moment === "unknown"
			? { tab: "raw", momentUnknown: true }
			: { tab: "raw", event: moment.event },
	);
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
