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

@keyframes slide-in-from-bottom {
	from {
		transform: translateY(100%);
	}
	to {
		transform: translateY(0);
	}
}

.animate-in {
	animation-duration: 300ms;
	animation-timing-function: ease-out;
}

.slide-in-from-top {
	animation-name: slide-in-from-top;
}

.slide-in-from-bottom {
	animation-name: slide-in-from-bottom;
}
</style>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Download, Share, WifiOff } from '@lucide/svelte';
import { onDestroy } from 'svelte';
import { writable } from 'svelte/store';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import { canInstall, installApp, isOnline, showIOSInstallPrompt } from '$lib/stores/pwa';
// Create a simple connection state based on socket readiness
import { socket } from '$lib/stores/websocket-store';

const connectionState = writable<'connected' | 'connecting' | 'disconnected' | 'error'>(
	'connecting',
);

// Monitor socket state with event listeners (more efficient than polling)
const updateConnectionState = () => {
	if (socket.readyState === WebSocket.OPEN) {
		connectionState.set('connected');
	} else if (socket.readyState === WebSocket.CONNECTING) {
		connectionState.set('connecting');
	} else {
		connectionState.set('disconnected'); // CLOSING, CLOSED, or any other state
	}
};

// Handle specific error events to set proper error state
const handleSocketError = () => {
	connectionState.set('error');
};

// Set initial state and add event listeners for efficient monitoring
updateConnectionState();
socket.addEventListener('open', updateConnectionState);
socket.addEventListener('close', updateConnectionState);
socket.addEventListener('error', handleSocketError);

// Cleanup function to prevent memory leaks
const cleanup = () => {
	socket.removeEventListener('open', updateConnectionState);
	socket.removeEventListener('close', updateConnectionState);
	socket.removeEventListener('error', handleSocketError);
};

// Call cleanup when component is destroyed
onDestroy(cleanup);

let showOfflineBanner = $state(false);

let showInstallBanner = $state(false);
let showIOSBanner = $state(false);

// Device detection - includes tablets like iPad
const isMobile = $derived(() => {
	if (typeof window === 'undefined') return false;

	// Check for touch capability with NaN safety
	const { maxTouchPoints } = navigator;
	const hasTouchScreen =
		'ontouchstart' in window || (isFinite(maxTouchPoints) && maxTouchPoints > 0);

	// Check user agent for mobile/tablet devices
	const userAgent = navigator.userAgent || '';
	const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
		userAgent,
	);

	// Combine touch capability with user agent detection
	return hasTouchScreen || isMobileUA;
});

// Reactive statements - consider both browser online state AND WebSocket connection
$effect(() => {
	const isFullyOffline =
		!$isOnline || $connectionState === 'disconnected' || $connectionState === 'error';

	if (isFullyOffline) {
		showOfflineBanner = true;
	} else if ($connectionState === 'connected' && $isOnline) {
		// Hide offline banner after a short delay when both are back online
		setTimeout(() => {
			showOfflineBanner = false;
		}, 2000);
	}
});

$effect(() => {
	showInstallBanner = $canInstall;
});

// Track banner state more carefully
let bannerDismissed = $state(false);

// Detect device type for better install experience
const isAndroid = $derived(() => {
	if (typeof window === 'undefined') return false;
	return /android/i.test(navigator.userAgent);
});

const isIOS = $derived(() => {
	if (typeof window === 'undefined') return false;
	return /iPad|iPhone|iPod/.test(navigator.userAgent);
});

$effect(() => {
	// Smart banner logic for mobile devices
	if (isMobile() && !bannerDismissed) {
		// Don't show if app is already installed
		const isStandalone =
			window.matchMedia('(display-mode: standalone)').matches ||
			(window.navigator as unknown as { standalone?: boolean }).standalone ||
			false; // Default to false if undefined

		if (isStandalone) {
			// App already installed, don't show any banner
			showIOSBanner = false;
		} else if (isAndroid()) {
			// Android: Always show blue banner (with install button if native prompt available)
			showIOSBanner = true;
		} else if (isIOS()) {
			// iOS: Show blue banner with instructions (no native prompt available)
			showIOSBanner = true;
		} else {
			// Other mobile devices: Show generic banner
			showIOSBanner = true;
		}
	} else {
		showIOSBanner = false;
	}
});

async function handleInstall() {
	try {
		const success = await installApp();
		if (success) {
			toast.success('App Installed', {
				description: 'CeraUI has been added to your home screen!',
			});
		} else {
			toast.info('Installation Cancelled', {
				description: 'You can install the app later from your browser menu.',
			});
		}
	} catch (error) {
		console.error('Installation failed:', error);
		toast.error('Installation Failed', {
			description: 'Unable to install the app. Please try again.',
		});
	}
}

function dismissIOSBanner() {
	showIOSBanner = false;
	bannerDismissed = true;
	showIOSInstallPrompt.set(false);
}

// Handle install for mobile banner (Android can use native prompt)
async function handleMobileInstall() {
	// For Android with native prompt available, use it
	if (isAndroid() && $canInstall) {
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
		class="bg-destructive text-destructive-foreground animate-in slide-in-from-top fixed top-0 right-0 left-0 z-50 p-3 text-center"
	>
		<div class="flex items-center justify-center gap-2">
			<WifiOff class="h-4 w-4" />
			<span class="text-sm font-medium">{$LL.pwa.offline()}</span>
			<span class="text-xs opacity-80">• {$LL.pwa.offlineDescription()}</span>
		</div>
	</div>
{/if}

<!-- Mobile Install App Banner - All mobile devices, fixed to bottom -->
{#if showIOSBanner && isMobile()}
	<div
		style:bottom="0px"
		style="
      bottom: env(safe-area-inset-bottom, 0px);
    "
		style:overflow-x="hidden"
		style:box-sizing="border-box"
		style:width="100%"
		style:max-width="100vw"
		style:transform="translateZ(0)"
		style:-webkit-transform="translateZ(0)"
		style:padding-bottom="calc(1rem + env(safe-area-inset-bottom, 0px))"
		class="animate-in slide-in-from-bottom fixed right-0 left-0 z-50 bg-blue-500 p-4 text-white"
	>
		<div class="mx-auto flex w-full max-w-sm items-center justify-between gap-3 px-2">
			<div class="flex min-w-0 flex-1 items-center gap-3">
				<Download class="h-5 w-5 flex-shrink-0" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{$LL.pwa.installTitle()}</p>
					<p class="truncate text-xs opacity-80">
						{#if isIOS()}
							Tap
							<Share class="mx-1 inline h-3 w-3" />
							{$LL.pwa.installIosDescription()}
						{:else if isAndroid() && $canInstall}
							{$LL.pwa.installAndroidDescription()}
						{:else if isAndroid()}
							{$LL.pwa.installAndroidMenuDescription()}
						{:else}
							{$LL.pwa.installDescription()}
						{/if}
					</p>
				</div>
			</div>
			<div class="flex flex-shrink-0 gap-2">
				{#if isAndroid() && $canInstall}
					<Button
						class="bg-white text-blue-500 hover:bg-white/90"
						onclick={handleMobileInstall}
						size="sm"
						variant="secondary"
					>
						{$LL.pwa.installButton()}
					</Button>
				{/if}
				<Button
					class="text-white hover:bg-white/20"
					onclick={dismissIOSBanner}
					size="sm"
					variant="ghost"
				>
					{isAndroid() && $canInstall ? $LL.pwa.installLater() : $LL.pwa.installIosGotIt()}
				</Button>
			</div>
		</div>
	</div>
{/if}
