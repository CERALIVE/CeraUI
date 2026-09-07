/**
 * REACTIVE `status` + `notifications` feed doubles for `Auth.svelte`.
 *
 * The production `getStatus()`/`getNotifications()` read `$state` values, so the
 * component's effects re-run on every broadcast. A plain `vi.fn()` returning a
 * mutable object is NOT reactive, so a test built on one would silently prove
 * that the component ignores late pushes — the same trap `tests/helpers/
 * modem-feed.svelte.ts` documents for the modem roster. These stay reactive.
 */
import type { NotificationsMessage, StatusResponse } from "@ceraui/rpc/schemas";

let statusFeed = $state<StatusResponse | undefined>(undefined);
let notificationsFeed = $state<NotificationsMessage | undefined>(undefined);

export function getStatusFeed(): StatusResponse | undefined {
	return statusFeed;
}

export function publishStatus(next: StatusResponse | undefined): void {
	statusFeed = next;
}

export function getNotificationsFeed(): NotificationsMessage | undefined {
	return notificationsFeed;
}

export function publishNotifications(
	next: NotificationsMessage | undefined,
): void {
	notificationsFeed = next;
}

export function resetAuthFeeds(): void {
	statusFeed = undefined;
	notificationsFeed = undefined;
}
