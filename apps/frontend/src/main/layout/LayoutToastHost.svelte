<script lang="ts">
import { getLL } from '@ceraui/i18n/svelte';
import { toast } from 'svelte-sonner';

import { Toaster } from '$lib/components/ui/sonner';
import { requestDialog } from '$lib/stores/dialog-request.svelte';
import {
	startStreaming as startStreamingFn,
	stopStreaming as stopStreamingFn,
} from '$lib/helpers/SystemHelper';
import { clearNotifications, dismiss, getActive } from '$lib/stores/notifications.svelte';

// Resolve the action label i18n key against the live translation tree, falling
// back to the raw key so an unknown label never blocks the deep-link affordance.
function resolveActionLabel(key: string): string {
	const ll = getLL() as Record<string, unknown>;
	let node: unknown = ll;
	for (const seg of key.split('.')) {
		if (node && typeof node === 'object' && seg in (node as object)) {
			node = (node as Record<string, unknown>)[seg];
		} else {
			return key;
		}
	}
	return typeof node === 'function' ? (node as () => string)() : key;
}

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

		const action = notification.action;
		toast[notification.type](notification.text, {
			id: notification.name,
			duration: notification.isPersistent
				? Number.POSITIVE_INFINITY
				: notification.durationMs,
			dismissable: notification.isDismissable,
			onDismiss: () => dismiss(notification.name),
			onAutoClose: () => dismiss(notification.name),
			...(action?.kind === 'navigate'
				? {
						action: {
							label: resolveActionLabel(action.labelKey),
							onClick: () => {
								requestDialog(action.target);
								toast.dismiss(notification.name);
							},
						},
					}
				: {}),
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
