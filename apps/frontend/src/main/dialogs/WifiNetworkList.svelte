<!--
  WifiNetworkList.svelte — scan bar + scrollable network list + empty state for
  the WifiSelectorDialog.

  Pure presentation extraction of the former monolith's body: the busy-count scan
  bar, the sorted network rows (signal / identity / per-network actions), and the
  no-results empty state. All state and the RPC connect/scan/forget logic stay in
  the parent dialog and are driven here via props + callbacks — identical markup
  and behaviour. The inline secured-network password form is delegated to
  WifiConnectForm.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AvailableWifiNetwork, WifiInterface } from '@ceraui/rpc/schemas';
import {
	Check,
	Loader2,
	Lock,
	Plug,
	RefreshCw,
	Trash2,
	TriangleAlert,
	Unlock,
	WifiOff,
} from '@lucide/svelte';

import InlineSpinner from '$lib/components/custom/InlineSpinner.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import { getWifiUUID } from '$lib/helpers/NetworkHelper';
import { getOperationPhase, isOperationPending } from '$lib/rpc/async-operation.svelte';
import { frequencyBand, isSecured, signalTextClass } from '$lib/helpers/wifi-selector';
import { cn } from '$lib/utils';

import WifiConnectForm from './WifiConnectForm.svelte';

interface Props {
	/** Live interface this list operates on (provides available count + saved map). */
	iface: WifiInterface | undefined;
	/** Pre-sorted networks to render (active → saved → signal). */
	networks: AvailableWifiNetwork[];
	/** Interface-level connect-in-flight guard. */
	ifaceBusy: boolean;
	/** Manual-scan spinner flag. */
	scanning: boolean;
	/** True when the last scan (manual or periodic) failed — drives the calm error state. */
	scanError?: boolean;
	/** WifiStatus key (interface device id) — drives the connect op phase reads. */
	deviceId: string;
	/** SSID of the network currently being connected, if any (local intent). */
	connecting: string | undefined;
	/** UUID of the saved network whose disconnect is in flight, if any. */
	disconnecting: string | undefined;
	/** UUID of the saved network whose forget is in flight, if any. */
	forgetting: string | undefined;
	/** The new secured network whose inline password form is expanded, if any. */
	pendingNew: AvailableWifiNetwork | undefined;
	/** SSID currently showing the forget-confirm affordance, if any. */
	confirmForget: string | undefined;
	/** Schema-derived password floor (WIFI_PASSWORD_MIN). */
	passwordMin: number;
	/** Bound password value for the inline connect form. */
	password: string;
	/** Bound reveal toggle for the inline connect form. */
	showPassword: boolean;
	onScan: () => void;
	onConnectSaved: (uuid: string, network: AvailableWifiNetwork) => void;
	onDisconnect: (uuid: string, network: AvailableWifiNetwork) => void;
	onConnectNew: (network: AvailableWifiNetwork) => void;
	onForget: (uuid: string, network: AvailableWifiNetwork) => void;
	onConfirmForget: (ssid: string | undefined) => void;
	onSubmitNew: () => void;
	onResetInteraction: () => void;
}

let {
	iface,
	networks,
	ifaceBusy,
	scanning,
	scanError = false,
	deviceId,
	connecting,
	disconnecting,
	forgetting,
	pendingNew,
	confirmForget,
	passwordMin,
	password = $bindable(),
	showPassword = $bindable(),
	onScan,
	onConnectSaved,
	onDisconnect,
	onConnectNew,
	onForget,
	onConfirmForget,
	onSubmitNew,
	onResetInteraction,
}: Props = $props();
</script>

<div class="flex flex-col gap-4">
	<!-- Scan bar -->
	<div class="bg-muted/50 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
		<div class="flex items-center gap-2 text-sm">
			<span class="text-foreground font-semibold tabular-nums">
				{iface?.available.length ?? 0}
			</span>
			<span class="text-muted-foreground">{$LL.wifiSelector.networks.found()}</span>
			{#if scanning}
				<InlineSpinner data-testid="wifi-scan-status" label={$LL.wifiSelector.button.scanning()} />
			{:else if ifaceBusy}
				<InlineSpinner label={$LL.wifiSelector.dialog.connecting()} />
			{/if}
		</div>
		<Button
			class="h-9 gap-2"
			data-testid="wifi-scan-button"
			disabled={scanning}
			onclick={onScan}
			size="sm"
			title={scanning ? $LL.wifiSelector.scanReason.scanning() : undefined}
			variant="outline"
		>
			{#if scanning}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
				<span>{$LL.wifiSelector.button.scanning()}</span>
			{:else}
				<RefreshCw class="size-4" />
				<span>{$LL.wifiSelector.button.scan()}</span>
			{/if}
		</Button>
	</div>

	<!-- Network list -->
	<div class="divide-y rounded-lg border">
		{#each networks as network (network.ssid)}
			{@const uuid = getWifiUUID(network, iface?.saved ?? {})}
			{@const opPending = isOperationPending(`wifi:${deviceId}`)}
			{@const isConnecting = connecting === network.ssid && opPending}
			{@const isConnectTimedOut =
				connecting === network.ssid && getOperationPhase(`wifi:${deviceId}`) === 'timed_out'}
			{@const isDisconnecting = !!uuid && disconnecting === uuid}
			{@const isForgetting = !!uuid && forgetting === uuid}
			{@const osBusy = !!connecting || !!disconnecting || !!forgetting}
			{@const expanded = pendingNew?.ssid === network.ssid}
			{@const confirming = confirmForget === network.ssid}
			<div
				class={cn(
					'flex flex-col gap-3 px-3 py-3 transition-colors',
					network.active && 'bg-primary/5',
				)}
			>
				<div class="flex items-center gap-3">
					<!-- Signal -->
					<div class="relative shrink-0">
						<LinkIndicator shape="icon" size="lg" type="wifi" signal={network.signal} />
						{#if network.active}
							<span
								class="bg-primary ring-background absolute -end-1.5 -top-1.5 grid size-3.5 place-items-center rounded-full ring-2"
							>
								<Check class="text-primary-foreground size-2.5" />
							</span>
						{/if}
					</div>

					<!-- Identity -->
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-1.5">
							<p
								class={cn(
									'truncate text-sm font-medium',
									network.active && 'text-primary',
								)}
								title={network.ssid}
							>
								{network.ssid}
							</p>
							{#if isSecured(network)}
								<Lock aria-hidden="true" class="text-muted-foreground size-3.5 shrink-0" />
								<span class="sr-only">{$LL.wifiSelector.accessibility.secured()}</span>
							{:else}
								<Unlock aria-hidden="true" class="text-status-warning size-3.5 shrink-0" />
								<span class="sr-only">{$LL.wifiSelector.accessibility.openNetwork()}</span>
							{/if}
							{#if uuid && !network.active}
								<span
									class="bg-muted text-muted-foreground text-micro rounded px-1.5 py-0.5 font-medium"
								>
									{$LL.wifiSelector.status.saved()}
								</span>
							{/if}
						</div>
						<div class="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
							<span class={cn('font-mono tabular-nums', signalTextClass(network.signal))}>
								{network.signal}%
							</span>
							<span aria-hidden="true">·</span>
							<span>{frequencyBand(network.freq)}</span>
							{#if network.active}
								<span aria-hidden="true">·</span>
								<span class="text-primary font-medium">{$LL.wifiSelector.status.connected()}</span>
							{/if}
						</div>
					</div>

					<!-- Actions -->
					<div class="flex shrink-0 items-center gap-1.5">
						{#if isConnecting}
							<InlineSpinner size="md" label={$LL.network.os.connecting()} />
						{:else if isConnectTimedOut}
							<span
								class="text-muted-foreground hidden items-center text-xs font-medium sm:inline-flex"
							>
								{$LL.network.os.stillWorking()}
							</span>
							<Button
								aria-label={`${$LL.network.os.retry()} ${network.ssid}`}
								class="gap-1.5"
								onclick={() => (uuid ? onConnectSaved(uuid, network) : onConnectNew(network))}
								size="sm"
								variant="outline"
							>
								<RefreshCw class="size-4" />
								<span class="hidden sm:inline">{$LL.network.os.retry()}</span>
							</Button>
						{:else if isDisconnecting}
							<InlineSpinner size="md" label={$LL.network.os.disconnecting()} />
						{:else if isForgetting}
							<InlineSpinner size="md" label={$LL.network.os.applying()} />
						{:else if confirming}
							<Button onclick={() => uuid && onForget(uuid, network)} size="sm" variant="destructive">
								{$LL.wifiSelector.button.forget()}
							</Button>
							<Button onclick={() => onConfirmForget(undefined)} size="sm" variant="ghost">
								{$LL.wifiSelector.dialog.close()}
							</Button>
						{:else if uuid}
							{#if network.active}
								<Button
									aria-label={`${$LL.wifiSelector.button.disconnect()} ${network.ssid}`}
									class="gap-1.5"
									disabled={osBusy}
									onclick={() => onDisconnect(uuid, network)}
									size="sm"
									variant="outline"
								>
									<WifiOff class="size-4" />
									<span class="hidden sm:inline">{$LL.wifiSelector.button.disconnect()}</span>
								</Button>
							{:else}
								<Button
									aria-label={`${$LL.wifiSelector.button.connect()} ${network.ssid}`}
									class="gap-1.5"
									disabled={ifaceBusy || osBusy}
									onclick={() => onConnectSaved(uuid, network)}
									size="sm"
								>
									<Plug class="size-4" />
									<span class="hidden sm:inline">{$LL.wifiSelector.button.connect()}</span>
								</Button>
							{/if}
							<Button
								aria-label={`${$LL.wifiSelector.button.forget()} ${network.ssid}`}
								class="text-muted-foreground hover:text-destructive size-9"
								disabled={osBusy}
								onclick={() => onConfirmForget(network.ssid)}
								size="icon"
								variant="ghost"
							>
								<Trash2 class="size-4" />
							</Button>
						{:else}
							<Button
								aria-label={`${$LL.wifiSelector.button.connect()} ${network.ssid}`}
								class="gap-1.5"
								disabled={ifaceBusy || osBusy}
								onclick={() => onConnectNew(network)}
								size="sm"
								variant={expanded ? 'outline' : 'default'}
							>
								<Plug class="size-4" />
								<span class="hidden sm:inline">{$LL.wifiSelector.button.connect()}</span>
							</Button>
						{/if}
					</div>
				</div>

				<!-- Inline password form for a new secured network -->
				{#if expanded}
					<WifiConnectForm
						{passwordMin}
						{ifaceBusy}
						onCancel={onResetInteraction}
						onSubmit={onSubmitNew}
						bind:password
						bind:showPassword
					/>
				{/if}
			</div>
		{:else}
			{#if scanning}
				<!-- Scanning state — distinct from the settled empty state below. -->
				<div
					class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
					data-testid="wifi-scanning-state"
				>
					<div class="bg-muted grid size-14 place-items-center rounded-2xl">
						<Loader2 class="text-muted-foreground size-7 animate-spin motion-reduce:animate-none" />
					</div>
					<div>
						<p class="text-sm font-semibold">{$LL.wifiSelector.scanningState.title()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{$LL.wifiSelector.scanningState.description()}
						</p>
					</div>
				</div>
			{:else if scanError}
				<!-- Scan-error state — a failing scan (manual or periodic), distinct
				     from the scanning + settled-empty states above. -->
				<div
					class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
					data-testid="wifi-scan-error"
				>
					<div class="bg-status-warning/10 grid size-14 place-items-center rounded-2xl">
						<TriangleAlert class="text-status-warning size-7" />
					</div>
					<div>
						<p class="text-sm font-semibold">{$LL.wifiSelector.scanError.title()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{$LL.wifiSelector.scanError.description()}
						</p>
					</div>
					<Button class="gap-2" disabled={scanning} onclick={onScan} size="sm" variant="outline">
						<RefreshCw class="size-4" />
						{$LL.wifiSelector.button.scan()}
					</Button>
				</div>
			{:else}
				<!-- Empty state -->
				<div
					class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
					data-testid="wifi-empty-state"
				>
					<div class="bg-muted grid size-14 place-items-center rounded-2xl">
						<WifiOff class="text-muted-foreground size-7" />
					</div>
					<div>
						<p class="text-sm font-semibold">{$LL.wifiSelector.emptyState.title()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{$LL.wifiSelector.emptyState.description()}
						</p>
					</div>
					<Button class="gap-2" disabled={scanning} onclick={onScan} size="sm">
						{#if scanning}
							<Loader2 class="size-4 animate-spin" />
						{:else}
							<RefreshCw class="size-4" />
						{/if}
						{$LL.wifiSelector.button.scan()}
					</Button>
				</div>
			{/if}
		{/each}
	</div>
</div>
