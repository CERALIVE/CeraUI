<script lang="ts">
import { directionFor, getLocale, m } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';

import { OfflinePage, PWAStatus } from '$lib/components/custom/pwa';
import { Button } from '$lib/components/ui/button';
import * as Tooltip from '$lib/components/ui/tooltip';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';
import { getStatus } from '$lib/rpc/subscriptions.svelte';
import {
	authenticateWithToken,
	authStatusStore,
	revokePersistentToken,
} from '$lib/stores/auth-status.svelte';
import {
	clearSessionExpired,
	deriveConnectionSurfaceUx,
	getDisconnectedSince,
	getGraceNow,
	markAuthenticated,
} from '$lib/stores/connection-ux.svelte';
import { getShouldShowOfflinePage } from '$lib/stores/offline-state.svelte';

import Auth from './Auth.svelte';
import DisconnectedBanner from './DisconnectedBanner.svelte';
import LayoutToastHost from './layout/LayoutToastHost.svelte';
import UpdateBanner from './layout/UpdateBanner.svelte';
import Main from './MainView.svelte';

let isCheckingAuthStatus = $state(true);
// Explicit terminal state for a stalled auth check: instead of silently
// blanking to the auth/loading screen when the check never resolves (offline
// device, dropped socket), we surface a calm role="status" retry surface.
let authTimedOut = $state(false);

const connectionSurfaces = $derived(
	deriveConnectionSurfaceUx(
		{ authTimedOut, disconnectedSince: getDisconnectedSince() },
		getGraceNow(),
	),
);
// One debounced verdict, owned by the store: `getShouldShowOfflinePage()` folds
// the offline-page REQUEST through the same shared grace every other
// connection-loss surface reads. This used to be re-composed here against the
// UNDEBOUNCED request, which left the other two consumers of that request
// (App's boot-shell gate, DisconnectedBanner's precedence input) reading a raw
// flag the browser `offline` event could flip instantly.
const showOfflinePage = $derived(getShouldShowOfflinePage());

// The overlay is DERIVED from the store, never mirrored into local state by an
// `$effect`. A mirror is a second copy of the same fact that only converges
// after the render that read it, so a re-mount or a reconnect renders the idle
// layout first and pops the overlay in afterwards. Reading the getter directly
// makes the mount trigger-agnostic AND flash-free by construction — see
// `Layout.updating-overlay.test.ts`.
const updatingStatus: StatusMessage['updating'] = $derived.by(() => {
	const updating = getStatus()?.updating;
	if (updating && typeof updating !== 'boolean' && updating.result !== 0) {
		return updating;
	}
	return false;
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
 * via the auth-status store's `authenticateWithToken()` — the SINGLE auth-state mutation
 * path — then handles its typed result without treating transport loss as a
 * credential rejection.
 */
function runAuthCheck() {
	authTimedOut = false;
	const auth = localStorage.getItem('auth');
	if (auth) {
		isCheckingAuthStatus = true;
		void authenticateWithToken(auth).then((attempt) => {
			switch (attempt.kind) {
				case 'ok':
					isCheckingAuthStatus = false;
					markAuthenticated();
					clearSessionExpired();
					return;
				case 'rejected':
					localStorage.removeItem('auth');
					isCheckingAuthStatus = false;
					authStatusStore.set(false);
					return;
				case 'unreachable':
					isCheckingAuthStatus = false;
					authTimedOut = true;
					return;
			}
		});
	} else {
		isCheckingAuthStatus = false;
	}
}

/** Retry the auth check from the timed-out surface. */
function retryAuthCheck() {
	runAuthCheck();
}

/**
 * Escape hatch from the timed-out surface for a STALE saved credential (device
 * password changed / storage carries a dead token): Retry alone would only
 * re-loop. Mirrors the existing session-expiry credential-clear at :115 —
 * removes the stored token and drops to the password screen. Only touches
 * localStorage + local Layout state; the sole auth-mutation owner
 * (auth-status.svelte) is untouched. `removeItem` is idempotent, so this is
 * safe with no stored credential.
 */
function clearSavedSession() {
	const stored = localStorage.getItem('auth');
	localStorage.removeItem('auth');
	authTimedOut = false;
	isCheckingAuthStatus = false;
	authStatusStore.set(false);
	// Retire it on the device too, so a credential this browser is giving up on
	// does not stay valid in auth_tokens.json forever. Deliberately not awaited:
	// the local clear is the operator's actual request.
	if (stored) void revokePersistentToken(stored);
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

// Reconnect re-authentication + safety hydrate now lives in the RPC layer
// (subscriptions.svelte `handleConnectionChange` → reconnect.ts), so it routes
// through the canonical handleMessage path and is unit-tested in isolation.

// Derived, not mirrored — same rule as `updatingStatus` above: a mirror lags the
// store by one render, which is a flash of the pre-auth shell on every re-mount.
const authStatus = $derived(authStatusStore.value);

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
	const active = getLocale();
	document.documentElement.lang = active;
	document.documentElement.dir = directionFor(active);
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
	{:else if connectionSurfaces.showAuthTimeout}
		<!-- Auth check stalled (offline device / dropped socket): a calm retry
		     surface instead of a blank screen, mirroring DisconnectedBanner. -->
		<div class="flex min-h-screen items-center justify-center p-4">
			<div
				class="bg-status-warning/10 border-status-warning/30 text-foreground flex max-w-sm flex-col items-center gap-3 rounded-lg border px-6 py-5 text-center text-sm backdrop-blur-sm"
				data-testid="auth-timeout"
				role="status"
			>
				<WifiOffIcon class="text-status-warning size-6 shrink-0" />
				<span class="font-medium">{m['connection.authTimedOut']()}</span>
				<div class="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
					<Button
						class="border-status-warning/40 text-status-warning hover:bg-status-warning/10 min-h-[44px]"
						onclick={retryAuthCheck}
						size="sm"
						variant="outline"
					>
						{m['connection.retry']()}
					</Button>
					<Button
						class="text-muted-foreground hover:text-foreground min-h-[44px]"
						data-testid="clear-saved-session"
						onclick={clearSavedSession}
						size="sm"
						variant="ghost"
					>
						{m['connection.clearSavedSession']()}
					</Button>
				</div>
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
