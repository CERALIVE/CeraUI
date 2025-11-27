<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
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
import type { StatusMessage } from '$lib/types/socket-messages';
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
	class="max-h-[90vh] max-w-[95vw] overflow-hidden sm:max-w-lg lg:max-w-xl"
	buttonText={$LL.wifiSelector.dialog.searchWifi()}
	confirmButtonText={$LL.wifiSelector.dialog.close()}
	extraButtonClasses="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg shadow-emerald-500/25 transition-all duration-300 hover:shadow-emerald-500/40 hover:scale-[1.02] active:scale-[0.98]"
	hiddeCancelButton={true}
	title={$LL.wifiSelector.dialog.searchWifi()}
	bind:open
>
	{#snippet icon()}
		<Wifi class="h-4 w-4" />
	{/snippet}
	{#snippet dialogTitle()}
		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/30"
			>
				<Radio class="h-5 w-5 text-white" />
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
			class="flex items-center justify-between rounded-xl border border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100 px-4 py-3 dark:border-slate-700 dark:from-slate-800/50 dark:to-slate-900/50"
		>
			<div class="flex items-center gap-2">
				<Signal class="h-4 w-4 text-emerald-500" />
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
						? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
						: 'bg-emerald-600 text-white shadow-md hover:bg-emerald-700 hover:shadow-lg',
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
			class="min-h-0 flex-1 rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/30"
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
								? 'border-emerald-400 bg-gradient-to-r from-emerald-50 to-teal-50 shadow-lg shadow-emerald-500/10 dark:border-emerald-600 dark:from-emerald-950/40 dark:to-teal-950/40'
								: 'border-transparent bg-slate-50 hover:border-slate-300 hover:bg-slate-100 dark:bg-slate-800/50 dark:hover:border-slate-600 dark:hover:bg-slate-800',
						)}
					>
						<!-- Active indicator glow -->
						{#if availableNetwork.active}
							<div class="absolute inset-0 bg-gradient-to-r from-emerald-500/5 to-teal-500/5"></div>
						{/if}

						<div class="relative flex items-center gap-4">
							<!-- Signal Indicator -->
							<div class="relative flex-shrink-0">
								<div
									class={cn(
										'flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-300',
										availableNetwork.active
											? 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/30'
											: signalCategory === 'excellent'
												? 'bg-gradient-to-br from-green-500 to-emerald-600'
												: signalCategory === 'good'
													? 'bg-gradient-to-br from-blue-500 to-cyan-600'
													: signalCategory === 'fair'
														? 'bg-gradient-to-br from-amber-500 to-orange-600'
														: 'bg-gradient-to-br from-red-500 to-rose-600',
									)}
								>
									<WifiQuality class="h-6 w-6 text-white" signal={availableNetwork.signal} />
								</div>
								{#if availableNetwork.active}
									<div
										class="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900"
									>
										<Check class="h-3 w-3 text-white" />
									</div>
								{/if}
							</div>

							<!-- Network Info -->
							<div class="min-w-0 flex-1">
								<div class="mb-1 flex items-center gap-2">
									<h4
										class={cn(
											'truncate text-base font-semibold transition-colors',
											availableNetwork.active
												? 'text-emerald-700 dark:text-emerald-400'
												: 'text-foreground',
										)}
										title={availableNetwork.ssid}
									>
										{availableNetwork.ssid}
									</h4>
									{#if availableNetwork.security.includes('WPA')}
										<Lock class="text-muted-foreground h-3.5 w-3.5 flex-shrink-0" />
									{:else}
										<Unlock class="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
									{/if}
								</div>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
									<span
										class={cn(
											'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
											signalCategory === 'excellent'
												? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
												: signalCategory === 'good'
													? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
													: signalCategory === 'fair'
														? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
														: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
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
										class="flex items-center gap-2 rounded-lg bg-blue-100 px-3 py-2 dark:bg-blue-900/40"
									>
										<Loader2 class="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
										<span class="text-xs font-medium text-blue-700 dark:text-blue-300">
											{$LL.wifiSelector.dialog.connecting()}
										</span>
									</div>
								{:else if uuid}
									<!-- Saved Network Actions -->
									<div class="flex items-center gap-1.5">
										{#if availableNetwork.active}
											<Button
												class="h-9 gap-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-3 text-white shadow-md transition-all hover:from-amber-600 hover:to-orange-600 hover:shadow-lg"
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
												class="h-9 gap-1.5 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 px-3 text-white shadow-md transition-all hover:from-blue-600 hover:to-indigo-600 hover:shadow-lg"
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
											buttonClasses="h-9 w-9 p-0 rounded-lg bg-slate-100 hover:bg-red-100 text-slate-500 hover:text-red-600 transition-all dark:bg-slate-800 dark:hover:bg-red-900/30 dark:text-slate-400 dark:hover:text-red-400"
											confirmButtonText={$LL.wifiSelector.button.forget()}
											extraButtonClasses="bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-600 hover:to-rose-700 text-white font-semibold"
											onconfirm={() => forgetWifi(uuid, availableNetwork)}
											title={$LL.wifiSelector.dialog.forgetNetwork()}
										>
											{#snippet icon()}
												<Trash2 class="h-4 w-4" />
											{/snippet}
											{#snippet dialogTitle()}
												<div class="flex items-center gap-3">
													<div
														class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-rose-600"
													>
														<Trash2 class="h-5 w-5 text-white" />
													</div>
													<div>
														<h3 class="text-foreground font-semibold">
															{$LL.wifiSelector.dialog.forgetNetwork()}
														</h3>
														<p
															class="max-w-[200px] truncate font-mono text-sm text-red-600 dark:text-red-400"
														>
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
										buttonClasses="h-9 gap-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-3 text-white shadow-md transition-all hover:from-emerald-600 hover:to-teal-600 hover:shadow-lg text-xs font-medium"
										confirmButtonText={$LL.wifiSelector.button.connect()}
										extraButtonClasses="bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-semibold"
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
													class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600"
												>
													<Wifi class="h-5 w-5 text-white" />
												</div>
												<div>
													<h3 class="text-foreground font-semibold">
														{$LL.wifiSelector.dialog.connectTo({ ssid: '' })}
													</h3>
													<p
														class="max-w-[200px] truncate font-mono text-sm text-emerald-600 dark:text-emerald-400"
													>
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
														class="h-11 rounded-xl border-2 border-slate-200 bg-slate-50 pr-12 font-mono text-sm transition-all focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800/50 dark:focus:border-emerald-500"
														placeholder={$LL.wifiSelector.hotspot.placeholderPassword()}
														type={showPassword ? 'text' : 'password'}
														bind:value={networkPassword}
													/>
													<button
														class="absolute top-1/2 right-3 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300"
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
							class="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-slate-800"
						>
							<WifiOff class="text-muted-foreground h-8 w-8" />
						</div>
						<h4 class="text-foreground mb-1 font-semibold">No Networks Found</h4>
						<p class="text-muted-foreground mb-4 max-w-xs text-sm">
							Click scan to search for available WiFi networks in your area.
						</p>
						<Button
							class="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
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
