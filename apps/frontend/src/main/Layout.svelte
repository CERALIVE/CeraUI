<script lang="ts">
import { rtlLanguages } from '@ceraui/i18n';
import { locale } from '@ceraui/i18n/svelte';
import type { NotificationType, StatusMessage } from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import { OfflinePage, PWAStatus } from '$lib/components/ui/pwa';
import { Toaster } from '$lib/components/ui/sonner';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';
import {
	startStreaming as startStreamingFn,
	stopStreaming as stopStreamingFn,
} from '$lib/helpers/SystemHelper';
import { authStatusStore } from '$lib/stores/auth-status.svelte';
import { getShouldShowOfflinePage } from '$lib/stores/offline-state.svelte';
import {
	getAuth,
	getNotifications,
	getStatus,
	sendAuthMessage,
} from '$lib/stores/websocket-store.svelte';

import Auth from './Auth.svelte';
import Main from './MainView.svelte';

let authStatus = $state(false);
let isCheckingAuthStatus = $state(true);
let updatingStatus: StatusMessage['updating'] = $state(false);

// Derived offline state for reactivity
const showOfflinePage = $derived(getShouldShowOfflinePage());

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

const showToast = (type: NotificationType, name: string, options: any) => {
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

// Svelte 5: Use $effect for side effects
$effect(() => {
	const status = getStatus();
	if (status?.updating && typeof status.updating !== 'boolean' && status.updating.result !== 0) {
		updatingStatus = status.updating;
	} else {
		updatingStatus = false;
	}
});
const auth = localStorage.getItem('auth');
if (auth) {
	sendAuthMessage(auth, true, () => {
		isCheckingAuthStatus = false;
	});

	// Add timeout for auth check in case we're offline (shorter for mobile/iOS)
	const isMobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
	const isPWA =
		window.matchMedia('(display-mode: standalone)').matches ||
		(window.navigator as any).standalone ||
		document.referrer.includes('android-app://');

	// Very aggressive timeout for PWA launches to prevent blank screens
	const authTimeout = isPWA ? 500 : isMobile ? 1500 : 3000;

	setTimeout(() => {
		if (isCheckingAuthStatus) {
			// If still checking after timeout, assume we're offline and stop checking
			isCheckingAuthStatus = false;
		}
	}, authTimeout);
} else {
	isCheckingAuthStatus = false;
}

$effect(() => {
	const message = getAuth();
	if (message?.success) {
		isCheckingAuthStatus = false;
		showToast('success', 'AUTH', {
			duration: 5000,
			description: 'Successfully authenticated',
			dismissable: true,
		});
		authStatusStore.set(true);
	}
});

// Svelte 5: Use $effect for auth status
$effect(() => {
	authStatus = authStatusStore.value;
});

// Aggressive fallback for mobile/PWA: if we're stuck in any loading state, assume offline with NaN safety
const userAgent = navigator.userAgent || '';
const isMobileDevice = /iphone|ipad|ipod|android/i.test(userAgent);
const isPWAApp =
	(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
	!!(window.navigator && (window.navigator as any).standalone) ||
	(document.referrer && document.referrer.includes('android-app://'));

if (isMobileDevice || isPWAApp) {
	const fallbackTimeout = isPWAApp ? 300 : 1000; // Even more aggressive for PWA

	setTimeout(() => {
		// If we're still in a loading state and no offline page is shown, force offline
		if (isCheckingAuthStatus && !authStatus && !showOfflinePage) {
			isCheckingAuthStatus = false;
			// This will trigger the auth screen, but offline detection should kick in soon
		}
	}, fallbackTimeout);
}

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

// Apply <html lang> and dir using runes-style effect
$effect(() => {
	// Update document language and direction for RTL support
	document.documentElement.lang = $locale;
	document.documentElement.dir = rtlLanguages.includes($locale) ? 'rtl' : 'ltr';
});
// Export our functions to the global scope to make them available to other components
window.startStreamingWithNotificationClear = startStreaming;
window.stopStreamingWithNotificationClear = stopStreaming;
</script>

{#if showOfflinePage}
	<OfflinePage />
{:else if authStatus}
	{#if updatingStatus && typeof updatingStatus !== 'boolean'}
		<UpdatingOverlay details={updatingStatus}></UpdatingOverlay>
	{/if}
	<Main></Main>
{:else if !isCheckingAuthStatus}
	<Auth></Auth>
{:else}
	<!-- Loading state while checking auth - show a basic loading indicator -->
	<div class="flex min-h-screen items-center justify-center">
		<div class="text-center">
			<div
				class="border-primary mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
			></div>
			<p class="text-muted-foreground">Loading...</p>
		</div>
	</div>
{/if}

<!-- PWA Status and Notifications -->
<PWAStatus />

<Toaster position="bottom-right" />
