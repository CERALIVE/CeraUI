<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';

import { Button } from '$lib/components/ui/button';
import { getConnectionState, getIsConnected } from '$lib/rpc/subscriptions.svelte';
import {
	deriveConnectionUx,
	getIsRebooting,
	getReconnectAttempts,
	retryConnection,
} from '$lib/stores/connection-ux.svelte';
import { getShouldShowOfflinePage } from '$lib/stores/offline-state.svelte';
import { getIsOnline } from '$lib/stores/pwa.svelte';

// Distinct from the browser-offline PWA page: this banner is the WS-down /
// reconnecting / rebooting treatment while the *browser* still has network.
// Reads the same `getIsConnected()` surface the HUD uses, so the banner and the
// HUD staleness model never disagree.
const ux = $derived(
	deriveConnectionUx({
		isConnected: getIsConnected(),
		connectionState: getConnectionState(),
		browserOnline: getIsOnline(),
		showOfflinePage: getShouldShowOfflinePage(),
		reconnectAttempts: getReconnectAttempts(),
		rebooting: getIsRebooting(),
	}),
);
</script>

{#if ux.showBanner}
	{#if ux.mode === 'rebooting'}
		<div
			aria-live="polite"
			class="bg-status-info/10 border-status-info/30 text-foreground sticky top-0 z-40 flex items-center gap-2.5 border-b px-4 py-2.5 text-sm backdrop-blur-sm"
			data-disconnect-banner="rebooting"
			role="status"
		>
			<RotateCwIcon class="text-status-info size-4 shrink-0 motion-safe:animate-spin" />
			<span class="font-medium">{$LL.connection.rebooting()}</span>
			<span class="text-muted-foreground hidden sm:inline">{$LL.connection.rebootingDescription()}</span>
		</div>
	{:else if ux.mode === 'failed'}
		<div
			aria-live="assertive"
			class="bg-status-error/10 border-status-error/30 text-foreground sticky top-0 z-40 flex items-center gap-2.5 border-b px-4 py-2.5 text-sm backdrop-blur-sm"
			data-disconnect-banner="failed"
			role="alert"
		>
			<WifiOffIcon class="text-status-error size-4 shrink-0" />
			<span class="font-medium">{$LL.connection.failed()}</span>
			<Button
				class="border-status-error/40 text-status-error hover:bg-status-error/10 ms-auto h-7"
				onclick={() => retryConnection()}
				size="sm"
				variant="outline"
			>
				{$LL.connection.retry()}
			</Button>
		</div>
	{:else}
		<div
			aria-live="polite"
			class="bg-status-warning/10 border-status-warning/30 text-foreground sticky top-0 z-40 flex items-center gap-2.5 border-b px-4 py-2.5 text-sm backdrop-blur-sm"
			data-disconnect-banner="reconnecting"
			role="status"
		>
			<LoaderCircleIcon class="text-status-warning size-4 shrink-0 motion-safe:animate-spin" />
			<span class="font-medium">{$LL.connection.lost()}</span>
		</div>
	{/if}
{/if}
