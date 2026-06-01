<!--
  WifiSelectorDialog.svelte — WiFi scan + connect flow for the Network destination.

  Opened from NetworkView's WiFi "Connect ▸" trigger. Composes on the shared
  AppDialog chrome (desktop Dialog / mobile Sheet).

  Data sources
  ------------
  • Network list: live `WifiStatus` from `$lib/rpc/subscriptions.svelte` (the
    non-deprecated surface) keyed by `deviceId`. Reactive — refreshes as scan
    results arrive.
  • Actions: the canonical `NetworkHelper` wrappers around `rpc.wifi.*`
    (scan / connect / connectNew / disconnect / forget). Those wrappers emit the
    "scanning…/connecting…" action toasts; the subscriptions `wifi` handler emits
    the success / auth-failure result toast, so this component does NOT duplicate
    result toasts — it only drives the inline UI (spinner, close-on-success).

  Validation
  ----------
  New-network password uses the schema-derived minimum
  (`networkConstraints.wifi.password.min`, WIFI_PASSWORD_MIN = 8). Inline error +
  disabled Connect when a secured network's password is shorter than the minimum.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AvailableWifiNetwork, WifiStatus } from '@ceraui/rpc/schemas';
import {
	Check,
	Eye,
	EyeOff,
	Loader2,
	Lock,
	Plug,
	RefreshCw,
	Trash2,
	Unlock,
	Wifi,
	WifiOff,
} from '@lucide/svelte';

import WifiQuality from '$lib/components/icons/WifiQuality.svelte';
import { networkConstraints } from '$lib/components/streaming/ValidationAdapter';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { getSignalCategory } from '$lib/helpers/signal';
import {
	connectToNewWifi,
	connectWifi,
	disconnectWifi,
	forgetWifi,
	getWifiUUID,
	networkRename,
	scanWifi,
} from '$lib/helpers/NetworkHelper';
import { getWifi } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	/** WifiStatus key (interface device id) this dialog operates on. */
	deviceId: string;
}

let { open = $bindable(false), deviceId }: Props = $props();

// Schema-derived password floor (WIFI_PASSWORD_MIN = 8) — single source of truth.
const PASSWORD_MIN = networkConstraints.wifi.password.min;

// Live interface from the non-deprecated subscriptions surface.
const wifi = $derived<WifiStatus | undefined>(getWifi());
const iface = $derived(wifi?.[deviceId]);
const ifaceLabel = $derived(iface ? networkRename(iface.ifname) : '');

const sortedNetworks = $derived(
	[...(iface?.available ?? [])].sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		const aSaved = !!getWifiUUID(a, iface?.saved ?? {});
		const bSaved = !!getWifiUUID(b, iface?.saved ?? {});
		if (aSaved !== bSaved) return aSaved ? -1 : 1;
		return b.signal - a.signal;
	}),
);

// Inline interaction state.
let scanning = $state(false);
let connecting = $state<{ key: string; ssid: string } | undefined>(undefined);
let pendingNew = $state<AvailableWifiNetwork | undefined>(undefined);
let password = $state('');
let showPassword = $state(false);
let confirmForget = $state<string | undefined>(undefined);

let connectTimeout: ReturnType<typeof setTimeout> | undefined;

function isSecured(network: AvailableWifiNetwork): boolean {
	return network.security.includes('WPA');
}

function frequencyBand(freq: number): string {
	if (freq >= 5000) return '5 GHz';
	if (freq >= 2400) return '2.4 GHz';
	return `${freq} MHz`;
}

/** Text colour token for a signal reading — matches NetworkView / SignalIndicator tiers. */
function signalTextClass(signal: number): string {
	switch (getSignalCategory(signal)) {
		case 'excellent':
			return 'text-signal-excellent';
		case 'good':
			return 'text-signal-good';
		case 'fair':
			return 'text-signal-fair';
		default:
			return 'text-signal-weak';
	}
}

function resetInteraction() {
	pendingNew = undefined;
	password = '';
	showPassword = false;
	confirmForget = undefined;
}

function beginConnect(key: string, ssid: string) {
	connecting = { key, ssid };
	clearTimeout(connectTimeout);
	// Safety: clear the spinner if no status update resolves the attempt.
	connectTimeout = setTimeout(() => {
		connecting = undefined;
	}, 20000);
}

function handleScan() {
	scanWifi(deviceId);
	scanning = true;
	setTimeout(() => {
		scanning = false;
	}, 20000);
}

function handleConnectSaved(uuid: string, network: AvailableWifiNetwork) {
	resetInteraction();
	beginConnect(uuid, network.ssid);
	connectWifi(uuid, network);
}

function handleDisconnect(uuid: string, network: AvailableWifiNetwork) {
	disconnectWifi(uuid, network);
}

/** New (unsaved) network: secured → reveal inline password form; open → connect now. */
function handleConnectNew(network: AvailableWifiNetwork) {
	confirmForget = undefined;
	if (isSecured(network)) {
		pendingNew = network;
		password = '';
		showPassword = false;
	} else {
		beginConnect(network.ssid, network.ssid);
		connectToNewWifi(deviceId, network.ssid, '');
	}
}

function submitNew() {
	if (!pendingNew) return;
	if (isSecured(pendingNew) && password.length < PASSWORD_MIN) return;
	const ssid = pendingNew.ssid;
	const pw = password;
	pendingNew = undefined;
	password = '';
	showPassword = false;
	beginConnect(ssid, ssid);
	connectToNewWifi(deviceId, ssid, pw);
}

function handleForget(uuid: string, network: AvailableWifiNetwork) {
	confirmForget = undefined;
	forgetWifi(uuid, network);
}

// Resolve the connecting spinner + close the dialog once the target goes active.
$effect(() => {
	const target = connecting;
	if (!target) return;
	const match = (iface?.available ?? []).find((n) => n.ssid === target.ssid);
	if (match?.active) {
		clearTimeout(connectTimeout);
		connecting = undefined;
		resetInteraction();
		open = false;
	}
});

// Initial + periodic silent rescan while the dialog is open.
$effect(() => {
	if (!open) return;
	scanWifi(deviceId, false);
	const id = setInterval(() => scanWifi(deviceId, false), 22000);
	return () => clearInterval(id);
});

// Clear transient inline state whenever the dialog closes.
$effect(() => {
	if (!open) {
		resetInteraction();
		connecting = undefined;
		scanning = false;
		clearTimeout(connectTimeout);
	}
});
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-xl"
	description={ifaceLabel}
	icon={Wifi}
	title={$LL.wifiSelector.dialog.availableNetworks()}
>
	<div class="flex flex-col gap-4">
		<!-- Scan bar -->
		<div class="bg-muted/50 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
			<div class="flex items-center gap-2 text-sm">
				<span class="text-foreground font-semibold tabular-nums">
					{iface?.available.length ?? 0}
				</span>
				<span class="text-muted-foreground">{$LL.wifiSelector.networks.found()}</span>
			</div>
			<Button
				class="h-9 gap-2"
				disabled={scanning}
				onclick={handleScan}
				size="sm"
				variant="outline"
			>
				{#if scanning}
					<Loader2 class="size-4 animate-spin" />
					<span>{$LL.wifiSelector.button.scanning()}</span>
				{:else}
					<RefreshCw class="size-4" />
					<span>{$LL.wifiSelector.button.scan()}</span>
				{/if}
			</Button>
		</div>

		<!-- Network list -->
		<div class="divide-y rounded-lg border">
			{#each sortedNetworks as network (network.ssid)}
				{@const uuid = getWifiUUID(network, iface?.saved ?? {})}
				{@const isConnecting = connecting?.ssid === network.ssid}
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
							<WifiQuality class="size-5" signal={network.signal} />
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
										class="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium"
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
								<span class="text-status-info inline-flex items-center gap-1.5 text-xs font-medium">
									<Loader2 class="size-4 animate-spin" />
									<span class="hidden sm:inline">{$LL.wifiSelector.dialog.connecting()}</span>
								</span>
							{:else if confirming}
								<Button onclick={() => uuid && handleForget(uuid, network)} size="sm" variant="destructive">
									{$LL.wifiSelector.button.forget()}
								</Button>
								<Button onclick={() => (confirmForget = undefined)} size="sm" variant="ghost">
									{$LL.wifiSelector.dialog.close()}
								</Button>
							{:else if uuid}
								{#if network.active}
									<Button
										aria-label={`${$LL.wifiSelector.button.disconnect()} ${network.ssid}`}
										class="gap-1.5"
										onclick={() => handleDisconnect(uuid, network)}
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
										onclick={() => handleConnectSaved(uuid, network)}
										size="sm"
									>
										<Plug class="size-4" />
										<span class="hidden sm:inline">{$LL.wifiSelector.button.connect()}</span>
									</Button>
								{/if}
								<Button
									aria-label={`${$LL.wifiSelector.button.forget()} ${network.ssid}`}
									class="text-muted-foreground hover:text-destructive size-9"
									onclick={() => (confirmForget = network.ssid)}
									size="icon"
									variant="ghost"
								>
									<Trash2 class="size-4" />
								</Button>
							{:else}
								<Button
									aria-label={`${$LL.wifiSelector.button.connect()} ${network.ssid}`}
									class="gap-1.5"
									onclick={() => handleConnectNew(network)}
									size="sm"
									variant={expanded ? 'secondary' : 'default'}
								>
									<Plug class="size-4" />
									<span class="hidden sm:inline">{$LL.wifiSelector.button.connect()}</span>
								</Button>
							{/if}
						</div>
					</div>

					<!-- Inline password form for a new secured network -->
					{#if expanded}
						{@const tooShort = password.length > 0 && password.length < PASSWORD_MIN}
						<div class="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
							<label class="text-muted-foreground text-xs" for="wifi-new-password">
								{$LL.wifiSelector.dialog.introducePassword()}
							</label>
							<div class="relative">
								<Input
									id="wifi-new-password"
									aria-invalid={tooShort}
									class="h-11 pe-11 font-mono"
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter') submitNew();
									}}
									placeholder={$LL.wifiSelector.hotspot.placeholderPassword()}
									type={showPassword ? 'text' : 'password'}
									bind:value={password}
								/>
								<button
									aria-label={showPassword
										? $LL.wifiSelector.accessibility.hidePassword()
										: $LL.wifiSelector.accessibility.showPassword()}
									class="text-muted-foreground hover:text-foreground hover:bg-accent absolute end-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 transition-colors"
									onclick={() => (showPassword = !showPassword)}
									type="button"
								>
									{#if showPassword}
										<EyeOff class="size-4" />
									{:else}
										<Eye class="size-4" />
									{/if}
								</button>
							</div>
							{#if tooShort}
								<p class="text-destructive text-xs" role="alert">
									{$LL.wifiSelector.validation.passwordMinLength()}
								</p>
							{/if}
							<div class="flex justify-end gap-2">
								<Button onclick={resetInteraction} size="sm" variant="ghost">
									{$LL.wifiSelector.dialog.close()}
								</Button>
								<Button disabled={password.length < PASSWORD_MIN} onclick={submitNew} size="sm">
									{$LL.wifiSelector.button.connect()}
								</Button>
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<!-- Empty state -->
				<div class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
					<div class="bg-muted grid size-14 place-items-center rounded-2xl">
						<WifiOff class="text-muted-foreground size-7" />
					</div>
					<div>
						<p class="text-sm font-semibold">{$LL.wifiSelector.emptyState.title()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{$LL.wifiSelector.emptyState.description()}
						</p>
					</div>
					<Button class="gap-2" disabled={scanning} onclick={handleScan} size="sm">
						{#if scanning}
							<Loader2 class="size-4 animate-spin" />
						{:else}
							<RefreshCw class="size-4" />
						{/if}
						{$LL.wifiSelector.button.scan()}
					</Button>
				</div>
			{/each}
		</div>
	</div>
</AppDialog>
