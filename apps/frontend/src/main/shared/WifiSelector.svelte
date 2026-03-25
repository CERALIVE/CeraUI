<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import {
	Check,
	Eye,
	EyeOff,
	Link,
	Loader2,
	Lock,
	Radio,
	ScanSearch,
	Signal,
	Trash2,
	Unlock,
	Wifi,
	WifiOff,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import WifiQuality from '$lib/components/icons/WifiQuality.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import {
	connectToNewWifi,
	connectWifi,
	disconnectWifi,
	forgetWifi,
	getWifiUUID,
	networkRename,
	scanWifi,
} from '$lib/helpers/NetworkHelper.js';
import { getWifi } from '$lib/stores/websocket-store.svelte';
import type { ValueOf } from '$lib/types';
import { cn } from '$lib/utils';

const { wifi, wifiId }: { wifi: ValueOf<StatusMessage['wifi']>; wifiId: number } = $props();
let networkPassword = $state('');
let showPassword = $state(false);
let open = $state(false);

let connecting: string | undefined = $state();
let scanning = $state(false);

// Svelte 5: Use $effect for side effects (toasts) based on wifi messages
$effect(() => {
	const wifiMessage = getWifi();
	if (wifiMessage) {
		if (wifiMessage.new?.error) {
			toast.error($LL.wifiSelector.error.connectionFailed(), {
				description: $LL.wifiSelector.error.connectionFailedDescription(),
			});
			connecting = undefined;
		} else if (wifiMessage.new?.success) {
			toast.success($LL.wifiSelector.success.connected(), {
				description: $LL.wifiSelector.success.connectedDescription(),
			});
			connecting = undefined;
			open = false;
		} else {
			connecting = undefined;
		}
	}
});

$effect(() => {
	let internal: NodeJS.Timeout;
	if (open) {
		internal = setInterval(() => {
			scanWifi(wifiId, false);
		}, 22000);
	}
	return () => clearInterval(internal);
});

const handleWifiScan = () => {
	scanWifi(wifiId);
	scanning = true;
	setTimeout(() => {
		scanning = false;
	}, 20000);
};

const handleWifiConnect = (
	uuid: string,
	wifi: ValueOf<StatusMessage['wifi']>['available'][number],
) => {
	connecting = uuid;
	connectWifi(uuid, wifi);
	networkPassword = '';
};

const handleNewWifiConnect = (ssid: string, password: string) => {
	connecting = ssid;
	connectToNewWifi(wifiId, ssid, password);
	networkPassword = '';
	showPassword = false;
};

// Get signal strength category for styling
const getSignalCategory = (signal: number): 'excellent' | 'good' | 'fair' | 'weak' => {
	if (signal >= 75) return 'excellent';
	if (signal >= 50) return 'good';
	if (signal >= 25) return 'fair';
	return 'weak';
};

// Get frequency band label
const getFrequencyBand = (freq: number): string => {
	if (freq >= 5000) return '5 GHz';
	if (freq >= 2400) return '2.4 GHz';
	return `${freq} MHz`;
};
</script>

<SimpleAlertDialog
	class="max-h-[90vh] w-full max-w-[95vw] overflow-hidden sm:max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl"
	buttonText={$LL.wifiSelector.dialog.searchWifi()}
	confirmButtonText={$LL.wifiSelector.dialog.close()}
	extraButtonClasses="w-full gradient-primary text-primary-foreground font-semibold shadow-lg shadow-primary/25 transition-all duration-300 hover:shadow-primary/40 hover:scale-[1.02] active:scale-[0.98]"
	hideCancelButton={true}
	title={$LL.wifiSelector.dialog.searchWifi()}
	bind:open
>
	{#snippet icon()}
		<Wifi class="h-4 w-4" />
	{/snippet}
	{#snippet dialogTitle()}
		<div class="flex items-center gap-3">
			<div
				class="gradient-primary flex h-10 w-10 items-center justify-center rounded-xl shadow-lg shadow-primary/30"
			>
				<Radio class="h-5 w-5 text-primary-foreground" />
			</div>
			<div>
				<h2 class="text-foreground text-lg font-bold">
					{$LL.wifiSelector.dialog.availableNetworks({ network: '' })}
				</h2>
				<p class="text-muted-foreground text-sm font-medium">
					{networkRename(wifi.ifname)}
				</p>
			</div>
		</div>
	{/snippet}

	<div class="flex max-h-[70vh] flex-col gap-4 overflow-hidden">
		<!-- Stats Bar -->
		<div
			class="border-border bg-muted flex items-center justify-between rounded-xl border px-4 py-3"
		>
			<div class="flex items-center gap-2">
				<Signal class="text-primary h-4 w-4" />
				<span class="text-foreground text-sm font-semibold">
					{wifi.available.length}
				</span>
				<span class="text-muted-foreground text-sm">
					{$LL.wifiSelector.networks.found()}
				</span>
			</div>
			<Button
				class={cn(
					'h-9 gap-2 rounded-lg px-4 text-sm font-medium transition-all duration-300',
					scanning
						? 'bg-primary/15 text-primary'
						: 'bg-primary text-primary-foreground shadow-md hover:bg-primary/90 hover:shadow-lg',
				)}
				disabled={scanning}
				onclick={handleWifiScan}
				size="sm"
			>
				{#if scanning}
					<Loader2 class="h-4 w-4 animate-spin" />
					<span>{$LL.wifiSelector.button.scanning()}</span>
				{:else}
					<ScanSearch class="h-4 w-4" />
					<span>{$LL.wifiSelector.button.scan()}</span>
				{/if}
			</Button>
		</div>

		<!-- WiFi Networks List -->
		<ScrollArea
			class="border-border bg-card/30 min-h-0 flex-1 rounded-xl border"
			type="auto"
		>
			<div class="space-y-2 p-3">
				{#each wifi.available as availableNetwork, index}
					{@const uuid = getWifiUUID(availableNetwork, wifi.saved)}
					{@const isConnecting =
						connecting !== undefined &&
						(connecting === uuid || connecting === availableNetwork.ssid)}
					{@const signalCategory = getSignalCategory(availableNetwork.signal)}

					<div
						style:animation-delay="{index * 50}ms"
						class={cn(
							'group relative overflow-hidden rounded-xl border-2 p-4 transition-all duration-300',
							availableNetwork.active
								? 'border-primary bg-primary/5 shadow-lg shadow-primary/10'
								: 'border-transparent bg-muted/50 hover:border-border hover:bg-accent',
						)}
					>
						<!-- Active indicator glow -->
						{#if availableNetwork.active}
							<div class="absolute inset-0 bg-primary/5"></div>
						{/if}

						<div class="relative flex items-center gap-4">
							<!-- Signal Indicator -->
							<div class="relative flex-shrink-0">
								<div
									class={cn(
										'flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-300',
										availableNetwork.active
											? 'gradient-primary shadow-lg shadow-primary/30'
											: signalCategory === 'excellent'
												? 'gradient-success'
												: signalCategory === 'good'
													? 'gradient-info'
													: signalCategory === 'fair'
														? 'gradient-warning'
														: 'gradient-destructive',
									)}
								>
									<WifiQuality
										class="h-6 w-6 text-primary-foreground"
										signal={availableNetwork.signal}
									/>
								</div>
								{#if availableNetwork.active}
									<div
										class="bg-primary ring-background absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full ring-2"
									>
										<Check class="h-3 w-3 text-primary-foreground" />
									</div>
								{/if}
							</div>

							<!-- Network Info -->
							<div class="min-w-0 flex-1">
								<div class="mb-1 flex items-center gap-2">
									<h4
										class={cn(
											'truncate text-base font-semibold transition-colors',
											availableNetwork.active ? 'text-primary' : 'text-foreground',
										)}
										title={availableNetwork.ssid}
									>
										{availableNetwork.ssid}
									</h4>
									{#if availableNetwork.security.includes('WPA')}
										<Lock class="text-muted-foreground h-3.5 w-3.5 flex-shrink-0" />
									{:else}
										<Unlock class="text-status-warning h-3.5 w-3.5 flex-shrink-0" />
									{/if}
								</div>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
									<span
										class={cn(
											'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
											signalCategory === 'excellent'
												? 'bg-status-success/15 text-status-success'
												: signalCategory === 'good'
													? 'bg-status-info/15 text-status-info'
													: signalCategory === 'fair'
														? 'bg-status-warning/15 text-status-warning'
														: 'bg-status-error/15 text-status-error',
										)}
									>
										{availableNetwork.signal}%
									</span>
									<span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
										{getFrequencyBand(availableNetwork.freq)}
									</span>
									<span
										class="text-muted-foreground hidden text-xs sm:inline"
										title={availableNetwork.security}
									>
										{availableNetwork.security.replaceAll(' ', '/')}
									</span>
								</div>
							</div>

							<!-- Actions -->
							<div class="flex flex-shrink-0 items-center gap-2">
								{#if isConnecting}
									<div
										class="bg-status-info/15 flex items-center gap-2 rounded-lg px-3 py-2"
									>
										<Loader2 class="text-status-info h-4 w-4 animate-spin" />
										<span class="text-status-info text-xs font-medium">
											{$LL.wifiSelector.dialog.connecting()}
										</span>
									</div>
								{:else if uuid}
									<!-- Saved Network Actions -->
									<div class="flex items-center gap-1.5">
										{#if availableNetwork.active}
											<Button
												class="gradient-warning text-status-warning-foreground h-9 gap-1.5 rounded-lg px-3 shadow-md transition-all hover:shadow-lg"
												onclick={() => disconnectWifi(uuid, availableNetwork)}
												size="sm"
											>
												<WifiOff class="h-4 w-4" />
												<span class="hidden text-xs font-medium sm:inline">
													{$LL.wifiSelector.button.disconnect()}
												</span>
											</Button>
										{:else}
											<Button
												class="gradient-info text-status-info-foreground h-9 gap-1.5 rounded-lg px-3 shadow-md transition-all hover:shadow-lg"
												onclick={() => handleWifiConnect(uuid, availableNetwork)}
												size="sm"
											>
												<Link class="h-4 w-4" />
												<span class="hidden text-xs font-medium sm:inline">
													{$LL.wifiSelector.button.connect()}
												</span>
											</Button>
										{/if}

										<!-- Forget Button -->
										<SimpleAlertDialog
											class="max-w-md"
											buttonClasses="bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-9 w-9 rounded-lg p-0 transition-all"
											confirmButtonText={$LL.wifiSelector.button.forget()}
											extraButtonClasses="gradient-destructive text-destructive-foreground font-semibold"
											onconfirm={() => forgetWifi(uuid, availableNetwork)}
											title={$LL.wifiSelector.dialog.forgetNetwork()}
										>
											{#snippet icon()}
												<Trash2 class="h-4 w-4" />
											{/snippet}
											{#snippet dialogTitle()}
												<div class="flex items-center gap-3">
													<div
														class="gradient-destructive flex h-10 w-10 items-center justify-center rounded-xl"
													>
														<Trash2 class="h-5 w-5 text-destructive-foreground" />
													</div>
													<div>
														<h3 class="text-foreground font-semibold">
															{$LL.wifiSelector.dialog.forgetNetwork()}
														</h3>
														<p class="text-destructive max-w-[200px] truncate font-mono text-sm">
															{availableNetwork.ssid}
														</p>
													</div>
												</div>
											{/snippet}
											{#snippet description()}
												<p class="text-muted-foreground">
													{$LL.wifiSelector.dialog.confirmForget({
														ssid: availableNetwork.ssid,
														network: networkRename(wifi.ifname),
													})}
												</p>
											{/snippet}
										</SimpleAlertDialog>
									</div>
								{:else}
									<!-- New Network - Connect Dialog -->
									<SimpleAlertDialog
										class="max-w-md"
										buttonClasses="gradient-primary text-primary-foreground h-9 gap-1.5 rounded-lg px-3 text-xs font-medium shadow-md transition-all hover:shadow-lg"
										confirmButtonText={$LL.wifiSelector.button.connect()}
										extraButtonClasses="gradient-primary text-primary-foreground font-semibold"
										oncancel={() => {
											networkPassword = '';
											showPassword = false;
										}}
										onconfirm={() => {
											handleNewWifiConnect(availableNetwork.ssid, networkPassword);
										}}
									>
										{#snippet icon()}
											<Link class="h-4 w-4" />
										{/snippet}
										{#snippet dialogTitle()}
											<div class="flex items-center gap-3">
												<div
													class="gradient-primary flex h-10 w-10 items-center justify-center rounded-xl"
												>
													<Wifi class="h-5 w-5 text-primary-foreground" />
												</div>
												<div>
													<h3 class="text-foreground font-semibold">
														{$LL.wifiSelector.dialog.connectTo({ ssid: '' })}
													</h3>
													<p class="text-primary max-w-[200px] truncate font-mono text-sm">
														{availableNetwork.ssid}
													</p>
												</div>
											</div>
										{/snippet}
										{#snippet description()}
											<div class="space-y-4">
												<p class="text-muted-foreground text-sm">
													{$LL.wifiSelector.dialog.introducePassword()}
												</p>
												<div class="relative">
													<Input
														class="border-border bg-muted focus:border-primary focus:ring-primary/20 h-11 rounded-xl border-2 pr-12 font-mono text-sm transition-all focus:bg-card focus:ring-4"
														placeholder={$LL.wifiSelector.hotspot.placeholderPassword()}
														type={showPassword ? 'text' : 'password'}
														bind:value={networkPassword}
													/>
													<button
														class="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 rounded-lg p-1.5 transition-colors"
														aria-label={showPassword
															? $LL.wifiSelector.accessibility.hidePassword()
															: $LL.wifiSelector.accessibility.showPassword()}
														onclick={() => (showPassword = !showPassword)}
														type="button"
													>
														{#if showPassword}
															<EyeOff class="h-4 w-4" />
														{:else}
															<Eye class="h-4 w-4" />
														{/if}
													</button>
												</div>
											</div>
										{/snippet}
									</SimpleAlertDialog>
								{/if}
							</div>
						</div>
					</div>
				{:else}
					<!-- Empty State -->
					<div class="flex flex-col items-center justify-center py-12 text-center">
						<div
							class="bg-muted mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
						>
							<WifiOff class="text-muted-foreground h-8 w-8" />
						</div>
						<h4 class="text-foreground mb-1 font-semibold">
							{$LL.wifiSelector.emptyState.title()}
						</h4>
						<p class="text-muted-foreground mb-4 max-w-xs text-sm">
							{$LL.wifiSelector.emptyState.description()}
						</p>
						<Button
							class="bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
							disabled={scanning}
							onclick={handleWifiScan}
						>
							{#if scanning}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<ScanSearch class="h-4 w-4" />
							{/if}
							{$LL.wifiSelector.button.scan()}
						</Button>
					</div>
				{/each}
			</div>
		</ScrollArea>
	</div>
</SimpleAlertDialog>
