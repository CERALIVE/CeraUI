<script lang="ts">
import { toast } from 'svelte-sonner';

import { Toaster } from '$lib/components/ui/sonner';
import {
	startStreaming as startStreamingFn,
	stopStreaming as stopStreamingFn,
} from '$lib/helpers/SystemHelper';
import { clearNotifications, dismiss, getActive } from '$lib/stores/notifications.svelte';

// Bookkeeping for which active notifications have already been surfaced as a
// toast. Keyed by the store's dedup key (`name`) → the `receivedAt` stamp of
// the entry we last rendered. A repeat push with the same name but a newer
// `receivedAt` re-fires the toast (svelte-sonner replaces in place via `id`),
// while an entry that drops out of `getActive()` gets its toast dismissed.
// This is plain bookkeeping, not reactive state — the only reactive dependency
// is `getActive()`.
const renderedAt = new Map<string, number>();

$effect(() => {
	const active = getActive();
	const activeNames = new Set<string>();

	for (const notification of active) {
		activeNames.add(notification.name);
		if (renderedAt.get(notification.name) === notification.receivedAt) continue;
		renderedAt.set(notification.name, notification.receivedAt);

		toast[notification.type](notification.text, {
			id: notification.name,
			duration: notification.isPersistent
				? Number.POSITIVE_INFINITY
				: notification.durationMs,
			dismissable: notification.isDismissable,
			onDismiss: () => dismiss(notification.name),
			onAutoClose: () => dismiss(notification.name),
		});
	}

	// Reap toasts whose notifications have left the active list.
	for (const name of renderedAt.keys()) {
		if (!activeNames.has(name)) {
			toast.dismiss(name);
			renderedAt.delete(name);
		}
	}
});

// Stream start/stop clears every active notification and dismisses any visible
// toasts. Exposed on `window` for the streaming call sites (LiveView,
// StreamingConfigService) that fire these before swapping the stream config.
const startStreaming = (config: Parameters<typeof startStreamingFn>[0]) => {
	toast.dismiss();
	clearNotifications();
	renderedAt.clear();
	startStreamingFn(config);
};

const stopStreaming = () => {
	toast.dismiss();
	clearNotifications();
	renderedAt.clear();
	stopStreamingFn();
};

window.startStreamingWithNotificationClear = startStreaming;
window.stopStreamingWithNotificationClear = stopStreaming;
</script>

<Toaster position="bottom-right" />
