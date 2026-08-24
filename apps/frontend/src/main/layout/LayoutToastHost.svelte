<script lang="ts">
import { resolveMessageKey } from '@ceraui/i18n/svelte';
import { MediaQuery } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';

import { Toaster } from '$lib/components/ui/sonner';
import { DESKTOP_CHROME_QUERY } from '$lib/layout';
import { requestDialog } from '$lib/stores/dialog-request.svelte';
import {
	startStreaming as startStreamingFn,
	stopStreaming as stopStreamingFn,
} from '$lib/helpers/SystemHelper';
import {
	clearNotifications,
	dismiss,
	getActive,
	push,
} from '$lib/stores/notifications.svelte';
import {
	deriveConnectionSurfaceUx,
	getDisconnectedSince,
	getGraceNow,
} from '$lib/stores/connection-ux.svelte';

// Resolve the action label i18n key against the live message registry, falling
// back to the raw key so an unknown label never blocks the deep-link affordance.
const resolveActionLabel = resolveMessageKey;

// Bookkeeping for which active notifications have already been surfaced as a
// toast. Keyed by the store's dedup key (`name`) → the `receivedAt` stamp of
// the entry we last rendered. A repeat push with the same name but a newer
// `receivedAt` re-fires the toast (svelte-sonner replaces in place via `id`),
// while an entry that drops out of `getActive()` gets its toast dismissed.
// This is plain bookkeeping, not reactive state — the only reactive dependency
// is `getActive()`.
const renderedAt = new Map<string, number>();
let connectionLossNotified = false;

const connectionSurfaces = $derived(
	deriveConnectionSurfaceUx(
		{ authTimedOut: false, disconnectedSince: getDisconnectedSince() },
		getGraceNow(),
	),
);

$effect(() => {
	if (connectionSurfaces.showConnectionLostToast && !connectionLossNotified) {
		connectionLossNotified = true;
		push({
			name: 'connection-lost',
			type: 'error',
			key: 'notifications.connectionLost',
			msg: 'Connection lost',
			is_dismissable: true,
			is_persistent: false,
			duration: 3,
		});
	} else if (!connectionSurfaces.showConnectionLostToast && connectionLossNotified) {
		connectionLossNotified = false;
		dismiss('connection-lost');
	}
});

// A toast is TRANSIENT by definition, so a persistent notification does not
// belong on this layer: given `Number.POSITIVE_INFINITY` it parked a card at
// z-index 999999999 forever, over the fixed mobile dock and over every dialog's
// primary action (task 41's fleet drill, 375/768/1024). Those notices render in
// flow instead — `main/notifications/PersistentNotices.svelte` — and keep their
// archive in the bell panel. Do NOT route them back through sonner.
$effect(() => {
	const active = getActive().filter((notification) => !notification.isPersistent);
	const activeNames = new Set<string>();

	for (const notification of active) {
		activeNames.add(notification.name);
		if (renderedAt.get(notification.name) === notification.receivedAt) continue;
		renderedAt.set(notification.name, notification.receivedAt);

		const action = notification.action;
		toast[notification.type](notification.text, {
			id: notification.name,
			duration: notification.durationMs,
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

// The mobile layout parks a FIXED dock on the bottom edge and the toast stack
// is anchored to that same edge, so without a clearance the card lands on the
// nav and wins its hit test — board-measured at BOTH 375x812 and 768x900, and
// the second is why this is keyed on MainView's own dock query rather than on
// sonner's 600px breakpoint, which does not fire at 768.
const isDesktop = new MediaQuery(DESKTOP_CHROME_QUERY);
const toasterOffset = $derived(
	isDesktop.current
		? undefined
		: {
				bottom:
					'calc(var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px) + 1rem)',
			},
);
</script>

<Toaster
	position="bottom-right"
	offset={toasterOffset}
	mobileOffset={toasterOffset}
/>
