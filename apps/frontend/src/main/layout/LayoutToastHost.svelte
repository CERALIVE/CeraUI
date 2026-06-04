<script lang="ts">
import type { NotificationType } from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import { Toaster } from '$lib/components/ui/sonner';
import {
	startStreaming as startStreamingFn,
	stopStreaming as stopStreamingFn,
} from '$lib/helpers/SystemHelper';
import { getNotifications } from '$lib/stores/websocket-store.svelte';

// Toast tracking system for duplicates
interface ToastInfo {
	id: string;
	timestamp: number;
	duration: number;
	notificationKey: string; // Unique key for identifying similar notifications
}

let activeToasts = $state<Record<string, ToastInfo>>({});
// Simple flag to prevent recursive updates
let isUpdatingToasts = false;

// Override original SystemHelper functions to add toast clearing
const startStreaming = (config: Parameters<typeof startStreamingFn>[0]) => {
	// Guard against infinite updates
	if (isUpdatingToasts) {
		startStreamingFn(config);
		return;
	}

	try {
		isUpdatingToasts = true;

		// Dismiss all visible toasts - this should work with Svelte 5
		toast.dismiss();

		// Clear all persistent notification timers
		Object.values(persistentNotificationTimers).forEach((timer) => {
			clearTimeout(timer);
		});

		// Reset tracking states safely using setTimeout to avoid reactive updates
		setTimeout(() => {
			activeToasts = {};
			persistentNotificationTimers = {};
		}, 0);

		// Now call the original function
		startStreamingFn(config);
	} finally {
		// Ensure flag is reset
		isUpdatingToasts = false;
	}
};

const stopStreaming = () => {
	// Guard against infinite updates
	if (isUpdatingToasts) {
		stopStreamingFn();
		return;
	}

	try {
		isUpdatingToasts = true;

		// Dismiss all visible toasts - this should work with Svelte 5
		toast.dismiss();

		// Clear all persistent notification timers
		Object.values(persistentNotificationTimers).forEach((timer) => {
			clearTimeout(timer);
		});

		// Reset tracking states safely using setTimeout to avoid reactive updates
		setTimeout(() => {
			activeToasts = {};
			persistentNotificationTimers = {};
		}, 0);

		// Now call the original function
		stopStreamingFn();
	} finally {
		// Ensure flag is reset
		isUpdatingToasts = false;
	}
};

// Show a toast, extending duration if a duplicate exists

export const showToast = (type: NotificationType, name: string, options: any) => {
	// Prevent recursive calls that could cause infinite loops
	if (isUpdatingToasts) return;

	try {
		isUpdatingToasts = true;

		// Generate a message-only key to identify toasts with the same content
		const messageKey = options.description;
		const now = Date.now();

		// For persistent notifications, don't create duplicates
		if (options.isPersistent) {
			// Check if we already have this persistent notification
			const existingPersistentToastEntries = Object.entries(activeToasts).filter(
				([_, toast]) => toast.notificationKey === messageKey && toast.duration === Infinity,
			);

			if (existingPersistentToastEntries.length > 0) {
				// We already have this persistent notification showing
				// The timer has already been reset in the subscription, so just skip creating a duplicate
				return;
			}
		}

		// Create a unique ID for this toast
		const id = `toast-${now}-${Math.random().toString(36).slice(2, 11)}`;
		options.id = id;

		// Ensure duration is a valid number
		options.duration = typeof options.duration === 'number' ? options.duration : 5000;

		// Simplified onDismiss handler
		const originalOnDismiss = options.onDismiss;
		options.onDismiss = () => {
			// Call original onDismiss if it exists
			if (originalOnDismiss) originalOnDismiss();

			// Safely update our tracking
			if (activeToasts[id]) {
				setTimeout(() => {
					const newActiveToasts = { ...activeToasts };
					delete newActiveToasts[id];
					activeToasts = newActiveToasts;
				}, 0);
			}
		};

		// Display the toast
		toast[type](name, options);

		// Track this toast
		const toastInfo = {
			id,
			timestamp: now,
			duration: options.duration,
			notificationKey: messageKey,
		};

		// Use a non-reactive way to update activeToasts to avoid triggering effects
		setTimeout(() => {
			activeToasts = { ...activeToasts, [id]: toastInfo };
		}, 0);

		// Clean up the toast tracking after it expires (except for persistent toasts)
		if (options.duration !== Infinity) {
			setTimeout(
				() => {
					try {
						// Remove problematic toast.dismiss(id) call - causes Svelte 5 compatibility issues
						// Let toast expire naturally instead of force dismissing

						setTimeout(() => {
							if (activeToasts[id]) {
								const newActiveToasts = { ...activeToasts };
								delete newActiveToasts[id];
								activeToasts = newActiveToasts;
							}
						}, 0);
					} catch (e) {
						console.error('Error cleaning up toast:', e);
					}
				},
				(typeof options.duration === 'number' ? options.duration : 5000) + 1000,
			); // Add 1 second buffer
		}
	} finally {
		// Always make sure we reset the flag
		isUpdatingToasts = false;
	}
};

// Time after which we'll automatically clear a persistent notification if no new updates arrive
const PERSISTENT_AUTO_CLEAR_TIMEOUT = 5000; // 5 seconds

// Track timers for auto-clearing persistent notifications
let persistentNotificationTimers = $state<Record<string, number>>({});

$effect(() => {
	const notifications = getNotifications();
	notifications?.show?.forEach((notification) => {
		const toastKey = `${notification.type}-${notification.msg}`;

		// If this is a persistent notification, reset/create its auto-clear timer
		if (notification.is_persistent) {
			// Clear any existing timer for this notification
			if (persistentNotificationTimers[toastKey]) {
				clearTimeout(persistentNotificationTimers[toastKey]);
			}

			// Set a new timer to auto-clear this notification if no new updates arrive
			const timerId = window.setTimeout(() => {
				// Find any toasts with this key
				Object.entries(activeToasts).forEach(([id, toastElement]) => {
					if (
						toastElement.notificationKey === notification.msg &&
						toastElement.duration === Infinity
					) {
						// Remove problematic toast.dismiss(toastElement.id) call - causes Svelte 5 compatibility issues
						// Let persistent toasts expire naturally instead of force dismissing

						// Update our tracking
						setTimeout(() => {
							const newActiveToasts = { ...activeToasts };
							delete newActiveToasts[id];
							activeToasts = newActiveToasts;
						}, 0);
					}
				});

				// Remove this timer from tracking
				setTimeout(() => {
					const newTimers = { ...persistentNotificationTimers };
					delete newTimers[toastKey];
					persistentNotificationTimers = newTimers;
				}, 0);
			}, PERSISTENT_AUTO_CLEAR_TIMEOUT);

			// Update the timers object
			const newTimers = { ...persistentNotificationTimers };
			newTimers[toastKey] = timerId;
			persistentNotificationTimers = newTimers;
		}

		// Show the toast
		showToast(notification.type as NotificationType, notification.name.toUpperCase(), {
			description: notification.msg,
			duration: notification.is_persistent ? Infinity : notification.duration * 2500,
			dismissable: !notification.is_dismissable,
			isPersistent: notification.is_persistent,
		});
	});
});

// Export our functions to the global scope to make them available to other components
window.startStreamingWithNotificationClear = startStreaming;
window.stopStreamingWithNotificationClear = stopStreaming;
</script>

<Toaster position="bottom-right" />
