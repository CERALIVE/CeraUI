<script lang="ts">
import { rtlLanguages } from '@ceraui/i18n';
import { locale } from '@ceraui/i18n/svelte';
import type { NotificationType, StatusMessage } from '@ceraui/rpc/schemas';

import { OfflinePage, PWAStatus } from '$lib/components/custom/pwa';
import * as Tooltip from '$lib/components/ui/tooltip';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';
import { authStatusStore } from '$lib/stores/auth-status.svelte';
import {
	clearSessionExpired,
	markAuthenticated,
	markSessionExpired,
	shouldExpireSession,
	wasAuthenticated,
} from '$lib/stores/connection-ux.svelte';
import { getShouldShowOfflinePage } from '$lib/stores/offline-state.svelte';
import { getAuth, getStatus, sendAuthMessage } from '$lib/stores/websocket-store.svelte';

import Auth from './Auth.svelte';
import DisconnectedBanner from './DisconnectedBanner.svelte';
import LayoutToastHost from './layout/LayoutToastHost.svelte';
import UpdateBanner from './layout/UpdateBanner.svelte';
import Main from './MainView.svelte';

let authStatus = $state(false);
let isCheckingAuthStatus = $state(true);
let updatingStatus: StatusMessage['updating'] = $state(false);

// Derived offline state for reactivity
const showOfflinePage = $derived(getShouldShowOfflinePage());

// Toast host instance — owns the de-duplicating toast subsystem and the
// `svelte-sonner` <Toaster>. The auth-success toast routes through its
// showToast() so it shares the same tracking/dedup path as notifications.
let toastHost = $state<{
	showToast: (type: NotificationType, name: string, options: unknown) => void;
}>();

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
		markAuthenticated();
		clearSessionExpired();
		toastHost?.showToast('success', 'AUTH', {
			duration: 5000,
			description: 'Successfully authenticated',
			dismissable: true,
		});
		authStatusStore.set(true);
	} else if (shouldExpireSession(message?.success, wasAuthenticated()) && authStatusStore.value) {
		// Auth token rejected mid-session (e.g. expired/invalidated on a reconnect).
		// Route to the auth gate with an explicit "session expired" message instead
		// of silently blanking. Device/streaming state in the stores is left intact.
		markSessionExpired();
		localStorage.removeItem('auth');
		authStatusStore.set(false);
	}
});

// Reconnect re-authentication + safety hydrate now lives in the RPC layer
// (subscriptions.svelte `handleConnectionChange` → reconnect.ts), so it routes
// through the canonical handleMessage path and is unit-tested in isolation.

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

// Apply <html lang> and dir using runes-style effect
$effect(() => {
	// Update document language and direction for RTL support
	document.documentElement.lang = $locale;
	document.documentElement.dir = rtlLanguages.includes($locale) ? 'rtl' : 'ltr';
});
</script>

<Tooltip.Provider>
	{#if showOfflinePage}
		<OfflinePage />
	{:else if authStatus}
		{#if updatingStatus && typeof updatingStatus !== 'boolean'}
			<UpdatingOverlay details={updatingStatus}></UpdatingOverlay>
		{/if}
		<UpdateBanner />
		<DisconnectedBanner />
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

	<LayoutToastHost bind:this={toastHost} />
</Tooltip.Provider>
