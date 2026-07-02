<script lang="ts">
import { rtlLanguages } from '@ceraui/i18n';
import { LL, locale } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';

import { OfflinePage, PWAStatus } from '$lib/components/custom/pwa';
import { Button } from '$lib/components/ui/button';
import * as Tooltip from '$lib/components/ui/tooltip';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';
import { getStatus } from '$lib/rpc/subscriptions.svelte';
import {
	authenticate,
	authStatusStore,
	getAuthMessage,
} from '$lib/stores/auth-status.svelte';
import {
	clearSessionExpired,
	markAuthenticated,
	markSessionExpired,
	shouldExpireSession,
	wasAuthenticated,
} from '$lib/stores/connection-ux.svelte';
import { getShouldShowOfflinePage } from '$lib/stores/offline-state.svelte';

import Auth from './Auth.svelte';
import DisconnectedBanner from './DisconnectedBanner.svelte';
import LayoutToastHost from './layout/LayoutToastHost.svelte';
import UpdateBanner from './layout/UpdateBanner.svelte';
import Main from './MainView.svelte';

let authStatus = $state(false);
let isCheckingAuthStatus = $state(true);
// Explicit terminal state for a stalled auth check: instead of silently
// blanking to the auth/loading screen when the check never resolves (offline
// device, dropped socket), we surface a calm role="status" retry surface.
let authTimedOut = $state(false);
let updatingStatus: StatusMessage['updating'] = $state(false);

// Derived offline state for reactivity
const showOfflinePage = $derived(getShouldShowOfflinePage());

// Svelte 5: Use $effect for side effects
$effect(() => {
	const status = getStatus();
	if (status?.updating && typeof status.updating !== 'boolean' && status.updating.result !== 0) {
		updatingStatus = status.updating;
	} else {
		updatingStatus = false;
	}
});
// Environment probes computed once (used to size the auth-check timeout).
const isMobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
const isPWA =
	window.matchMedia('(display-mode: standalone)').matches ||
	(typeof (window.navigator as unknown as { standalone?: boolean }).standalone === 'boolean' &&
		(window.navigator as unknown as { standalone?: boolean }).standalone) ||
	document.referrer.includes('android-app://');

// Very aggressive timeout for PWA launches to prevent blank screens.
const authTimeout = isPWA ? 500 : isMobile ? 1500 : 3000;

/**
 * Kick off (or re-run) the stored-token auth check. Called once on mount and
 * again from the timed-out retry surface. Dispatches a typed `rpc.auth.login`
 * via the auth-status store's `authenticate()` — the SINGLE auth-state mutation
 * path (ingestAuth). The `$effect` block below observes the resulting
 * `getAuthMessage()` snapshot to complete/reject the check.
 */
function runAuthCheck() {
	authTimedOut = false;
	const auth = localStorage.getItem('auth');
	if (auth) {
		isCheckingAuthStatus = true;
		void authenticate(auth, true);
	} else {
		isCheckingAuthStatus = false;
	}
}

/** Retry the auth check from the timed-out surface. */
function retryAuthCheck() {
	runAuthCheck();
}

runAuthCheck();

// Timeout for the auth check in case we're offline: wrapped in $effect so the
// timer is cleared on unmount (no post-unmount state mutation, no leaked timer)
// and re-armed whenever a retry flips isCheckingAuthStatus back to true. On
// expiry we surface an explicit authTimedOut state instead of silently blanking.
$effect(() => {
	if (!isCheckingAuthStatus) return;
	const id = setTimeout(() => {
		if (isCheckingAuthStatus) {
			isCheckingAuthStatus = false;
			authTimedOut = true;
		}
	}, authTimeout);
	return () => clearTimeout(id);
});

$effect(() => {
	const message = getAuthMessage();
	if (message?.success) {
		isCheckingAuthStatus = false;
		markAuthenticated();
		clearSessionExpired();
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
	(window.matchMedia?.('(display-mode: standalone)').matches) ||
	(typeof (window.navigator as unknown as { standalone?: boolean }).standalone === 'boolean' &&
		!!(window.navigator && (window.navigator as unknown as { standalone?: boolean }).standalone)) ||
	(document.referrer?.includes('android-app://'));

// Aggressive fallback for mobile/PWA to prevent blank screens: wrapped in
// $effect so the timer is cleared on unmount and re-armed on retry. On expiry
// we surface the explicit authTimedOut state rather than silently blanking.
$effect(() => {
	if (!(isMobileDevice || isPWAApp)) return;
	if (!isCheckingAuthStatus || authStatus || showOfflinePage) return;
	const fallbackTimeout = isPWAApp ? 300 : 1000; // Even more aggressive for PWA
	const id = setTimeout(() => {
		// If we're still in a loading state and no offline page is shown, time out.
		if (isCheckingAuthStatus && !authStatus && !showOfflinePage) {
			isCheckingAuthStatus = false;
			authTimedOut = true;
		}
	}, fallbackTimeout);
	return () => clearTimeout(id);
});

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
	{:else if authTimedOut}
		<!-- Auth check stalled (offline device / dropped socket): a calm retry
		     surface instead of a blank screen, mirroring DisconnectedBanner. -->
		<div class="flex min-h-screen items-center justify-center p-4">
			<div
				class="bg-status-warning/10 border-status-warning/30 text-foreground flex max-w-sm flex-col items-center gap-3 rounded-lg border px-6 py-5 text-center text-sm backdrop-blur-sm"
				data-testid="auth-timeout"
				role="status"
			>
				<WifiOffIcon class="text-status-warning size-6 shrink-0" />
				<span class="font-medium">{$LL.connection.authTimedOut()}</span>
				<Button
					class="border-status-warning/40 text-status-warning hover:bg-status-warning/10"
					onclick={retryAuthCheck}
					size="sm"
					variant="outline"
				>
					{$LL.connection.retry()}
				</Button>
			</div>
		</div>
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

	<LayoutToastHost />
</Tooltip.Provider>
