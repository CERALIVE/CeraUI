<style>
/* Custom animations for better mobile experience */
@keyframes slide-in-from-top {
	from {
		transform: translateY(-100%);
	}
	to {
		transform: translateY(0);
	}
}

/* The install banner fades in: a slide would carry it across the dock or the
   Live bar it rests on. */
@keyframes fade-in {
	from {
		opacity: 0;
	}
}

.animate-in {
	animation-duration: 300ms;
	animation-timing-function: ease-out;
}

.slide-in-from-top {
	animation-name: slide-in-from-top;
}

.fade-in {
	animation-name: fade-in;
}

	/* Where the install banner rests: on the top edge of MainView's dock as
	   measured (`--mobile-dock-offset`, safe area included), or of the Live bar
	   where one is mounted (that bar sits on the `--mobile-dock-height` token, so
	   its top is that plus its own height; with no Live bar the -100vh fallback
	   drops the term out of the max), above the Live bar's open Start checklist
	   (`--live-checklist-height`, as the toast stack does), or with no dock
	   (sign-in, setup) on the screen edge. KEEP IN SYNC with DESKTOP_CHROME_QUERY ($lib/layout), as
	   LiveBar does: under desktop chrome there is no dock and the Live bar sits on
	   the edge. */
	:global(:root) {
		--install-banner-bottom: max(
			var(--mobile-dock-offset, 0px),
			calc(
				var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px) + var(--live-bar-height, -100vh) +
					var(--live-checklist-height, 0px)
			)
		);
	}

	@media (min-width: 1024px), (min-width: 768px) and (max-height: 600px) {
		:global(:root) {
			--install-banner-bottom: calc(var(--live-bar-height, 0px) + var(--live-checklist-height, 0px));
		}
	}

	/* The most it could take is the room up to the header; the fit check reads
	   that max-height to decide whether it shows at all. */
	.install-banner {
		bottom: var(--install-banner-bottom);
		max-height: calc(
			100dvh - var(--install-banner-bottom) - var(--offline-bar-height) - var(--top-bands-height) -
				var(--app-header-height, 0px)
		);
	}

	.install-banner:not([data-shown]) {
		visibility: hidden;
	}

	/* While it shows, the page ends its height later, so the last content can
	   scroll clear of it; a full-height screen that centres its content centres
	   it in the room the banner leaves (`min-h-room` reads the reserve); and a
	   control reached with Tab or scrolled into view
	   stops above it and all the chrome below it (WCAG 2.4.11), as the Live
	   bar's does; this rule outranks the Live bar's while both show. */
	:global(html:has(.install-banner[data-shown])) {
		--install-banner-reserve: var(--install-banner-height, 0px);
		padding-bottom: var(--install-banner-reserve);
		scroll-padding-bottom: calc(var(--install-banner-bottom) + var(--install-banner-height, 0px));
	}
</style>

<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Download, LoaderCircle, Share, WifiOff } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { publishHeight } from '$lib/layout';
import {
	deriveConnectionSurfaceUx,
	getConnectionLossCause,
	getDisconnectedSince,
	getGraceNow,
} from '$lib/stores/connection-ux.svelte';
import { push } from '$lib/stores/notifications.svelte';
import {
	getCanInstall,
	installApp,
	setShowIOSInstallPrompt,
} from '$lib/stores/pwa.svelte';

const showOfflineBanner = $derived(
	deriveConnectionSurfaceUx(
		{ authTimedOut: false, disconnectedSince: getDisconnectedSince() },
		getGraceNow(),
	).showOfflineBanner,
);
// The same banner covers two different losses. Only a browser without network
// is "offline"; a dropped device socket on a working network is named as such,
// and its wording must not suggest the device stopped streaming.
const browserOffline = $derived(getConnectionLossCause() === 'browser-offline');

// The bar is fixed over the top of the page and takes no space of its own; the
// height it publishes is what app.css moves the page and its sticky bands by.
let offlineBar: HTMLDivElement | undefined = $state();
$effect(() => (offlineBar ? publishHeight(offlineBar, '--offline-bar-height') : undefined));

// The install banner rests on the bottom chrome instead of over it (where, is
// in the <style> block). It never takes more of the screen than it leaves to the
// page: where its whole height is over half the room between the top chrome and
// that edge (a short or landscape phone, an open Start checklist) it steps
// aside, and it returns when the room grows. The room is the banner's own
// max-height, which the browser resolves to px; it changes with the layout
// viewport and with every height the chrome publishes on the root. A soft
// keyboard that resizes only the visual viewport (the default without an
// interactive-widget viewport hint) leaves this room unchanged. Its own height is published too, so the page
// can end that much later while it shows.
let banner: HTMLDivElement | undefined = $state();
let bannerFits = $state(true);
$effect(() => (banner ? publishHeight(banner, '--install-banner-height') : undefined));
$effect(() => {
	// Absent ResizeObserver (jsdom) no height is published, so it measures nothing
	// and stays shown. Its own size changes reach it through its published height.
	if (!banner || typeof ResizeObserver === 'undefined') return;
	const el = banner;
	const measure = () => {
		bannerFits = el.scrollHeight * 2 <= Number.parseFloat(getComputedStyle(el).maxHeight);
	};
	measure();
	const chrome = new MutationObserver(measure);
	chrome.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
	window.addEventListener('resize', measure);
	return () => {
		chrome.disconnect();
		window.removeEventListener('resize', measure);
	};
});

// Reactive derived values for PWA state
const canInstallApp = $derived(getCanInstall());

// Device detection - includes tablets like iPad.
// `$derived.by`, not `$derived(() => …)`: the latter yields a FUNCTION, so every
// call site re-ran the probe on every render instead of reading a value.
const isMobile = $derived.by(() => {
	if (typeof window === 'undefined') return false;

	// Check for touch capability with NaN safety
	const { maxTouchPoints } = navigator;
	const hasTouchScreen =
		'ontouchstart' in window || (Number.isFinite(maxTouchPoints) && maxTouchPoints > 0);

	// Check user agent for mobile/tablet devices
	const userAgent = navigator.userAgent || '';
	const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
		userAgent,
	);

	// Combine touch capability with user agent detection
	return hasTouchScreen || isMobileUA;
});

// Track banner state more carefully
let bannerDismissed = $state(false);

// Detect device type for better install experience
const isAndroid = $derived.by(() => {
	if (typeof window === 'undefined') return false;
	return /android/i.test(navigator.userAgent);
});

const isIOS = $derived.by(() => {
	if (typeof window === 'undefined') return false;
	return /iPad|iPhone|iPod/.test(navigator.userAgent);
});

const isStandalone = $derived.by(() => {
	if (typeof window === 'undefined') return false;
	return (
		window.matchMedia('(display-mode: standalone)').matches ||
		(window.navigator as unknown as { standalone?: boolean }).standalone ||
		false // Default to false if undefined
	);
});

// Android, iOS and "other mobile" all resolved to the same answer, so the
// branch was one condition wearing three coats: offer the install banner to a
// mobile browser that has not already installed the app and has not dismissed
// it. Derived rather than mirrored into `$state` by an `$effect`.
const showIOSBanner = $derived(isMobile && !bannerDismissed && !isStandalone);

async function handleInstall() {
	try {
		const success = await installApp();
		if (success) {
			push({
				name: 'appInstalled',
				type: 'success',
				msg: 'App Installed',
				key: 'notifications.appInstalled',
				is_dismissable: true,
				is_persistent: false,
				duration: 5,
			});
		} else {
			push({
				name: 'installCancelled',
				type: 'info',
				msg: 'Installation Cancelled',
				key: 'notifications.installCancelled',
				is_dismissable: true,
				is_persistent: false,
				duration: 5,
			});
		}
	} catch (error) {
		console.error('Installation failed:', error);
		push({
			name: 'installFailed',
			type: 'error',
			msg: 'Installation Failed',
			key: 'notifications.installFailed',
			is_dismissable: true,
			is_persistent: false,
			duration: 5,
		});
	}
}

function dismissIOSBanner() {
	bannerDismissed = true;
	setShowIOSInstallPrompt(false);
}

// Handle install for mobile banner (Android can use native prompt)
async function handleMobileInstall() {
	// For Android with native prompt available, use it
	if (isAndroid && getCanInstall()) {
		await handleInstall();
		dismissIOSBanner();
	} else {
		// For iOS or Android without native prompt, just dismiss
		dismissIOSBanner();
	}
}
</script>

<!-- Offline Status Banner -->
{#if showOfflineBanner}
	<div
		bind:this={offlineBar}
		class="bg-destructive text-destructive-foreground animate-in slide-in-from-top fixed top-0 right-0 left-0 z-50 p-3 text-center"
		data-testid="offline-bar"
	>
		<div class="flex items-center justify-center gap-2">
			{#if browserOffline}
				<WifiOff class="h-4 w-4" />
				<span class="text-sm font-medium">{m["pwa.offline"]()}</span>
				<span class="text-xs opacity-80">• {m["pwa.offlineDescription"]()}</span>
			{:else}
				<LoaderCircle class="h-4 w-4 motion-safe:animate-spin" />
				<span class="text-sm font-medium">{m["pwa.deviceNotConnected"]()}</span>
				<span class="text-xs opacity-80">• {m["pwa.deviceNotConnectedDescription"]()}</span>
			{/if}
		</div>
	</div>
{/if}

<!-- Mobile install banner: fixed on the bottom chrome. It fades in rather than
     sliding, so even its entrance never crosses the dock or the Live bar. -->
{#if showIOSBanner && isMobile}
	<div
		bind:this={banner}
		data-shown={bannerFits || undefined}
		style:overflow-x="hidden"
		style:box-sizing="border-box"
		style:width="100%"
		style:max-width="100vw"
		style:transform="translateZ(0)"
		style:-webkit-transform="translateZ(0)"
		style:padding-bottom="calc(1rem + env(safe-area-inset-bottom, 0px))"
		class="install-banner animate-in fade-in bg-primary text-primary-foreground fixed right-0 left-0 z-50 p-4 [--touch-target-min:44px]"
		data-testid="pwa-install-banner"
		data-touch-region
	>
		<!-- Only touch browsers get this banner, so its compact buttons answer to a
		     44px hit area at every width, through app.css's hit-area overlay. -->
		<div class="mx-auto flex w-full max-w-sm flex-wrap items-center justify-between gap-3 px-2">
			<div class="text-slot flex items-center gap-3">
				<Download class="h-5 w-5 flex-shrink-0" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{m["pwa.installTitle"]()}</p>
					<p class="text-xs opacity-80">
						{#if isIOS}
							{m["pwa.installIosBeforeShare"]()}
							<Share class="mx-1 inline h-3 w-3" />
							{m["pwa.installIosDescription"]()}
						{:else if isAndroid && canInstallApp}
							{m["pwa.installAndroidDescription"]()}
						{:else if isAndroid}
							{m["pwa.installAndroidMenuDescription"]()}
						{:else}
							{m["pwa.installDescription"]()}
						{/if}
					</p>
				</div>
			</div>
			<div class="ms-auto flex flex-shrink-0 gap-2">
				{#if isAndroid && canInstallApp}
					<Button
						class="bg-primary-foreground text-primary hover:bg-primary-foreground/90 relative"
						data-touch-target="hit-area"
						onclick={handleMobileInstall}
						size="sm"
						variant="secondary"
					>
						{m["pwa.installButton"]()}
					</Button>
				{/if}
				<Button
					class="text-primary-foreground hover:bg-primary-foreground/20 relative"
					data-touch-target="hit-area"
					onclick={dismissIOSBanner}
					size="sm"
					variant="ghost"
				>
					{isAndroid && canInstallApp ? m["pwa.installLater"]() : m["pwa.installIosGotIt"]()}
				</Button>
			</div>
		</div>
	</div>
{/if}
