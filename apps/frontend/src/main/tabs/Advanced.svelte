<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CustomProviderInput, ProviderSelection } from '@ceraui/rpc/schemas';
import {
	Cloud,
	Copy,
	Eye,
	EyeOff,
	Hammer,
	Logs,
	PowerOff,
	RotateCcw,
	Settings,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import {
	getDeviceLog,
	getSystemLog,
	powerOff,
	reboot,
	resetSSHPasword,
	savePassword,
	saveRemoteConfig,
	startSSH,
	stopSSH,
} from '$lib/helpers/SystemHelper';
import { getConfig, getRevisions, getStatus } from '$lib/stores/websocket-store.svelte';
import { cn } from '$lib/utils';

type CustomProvider = CustomProviderInput;

// Cloud provider definitions
const CLOUD_PROVIDERS = [
	{
		id: 'ceralive' as const,
		name: 'CeraLive Cloud',
		cloudUrl: 'https://cloud.ceralive.net',
	},
	{
		id: 'belabox' as const,
		name: 'BELABOX Cloud',
		cloudUrl: 'https://cloud.belabox.net',
	},
	{
		id: 'custom' as const,
		name: 'Custom Provider',
		cloudUrl: undefined,
	},
] as const;

let remoteKey = $state('');
let selectedProvider = $state<ProviderSelection>('ceralive');
let customProviderName = $state('');
let customProviderHost = $state('');
let customProviderSecure = $state(true);

let showPassword = $state(false);
let showRemoteKey = $state(false);
let showSSHPassword = $state(false);

let password = $state('');
let sshPasswordChanged = $state(false);
let lastSshPassword = $state('');

// Svelte 5: Use $derived for computed state
const currentRemoteKey = $derived(getConfig()?.remote_key ?? '');
const currentProvider = $derived(getConfig()?.remote_provider ?? 'ceralive');
const currentCustomProvider = $derived(getConfig()?.custom_provider);
const revisions = $derived(getRevisions());
const sshPassword = $derived(getConfig()?.ssh_pass ?? '');
const sshStatus = $derived(getStatus()?.ssh?.active ?? false);
const sshUser = $derived(getStatus()?.ssh?.user ?? '');

// Get current provider's cloud URL
const currentCloudUrl = $derived(() => {
	if (selectedProvider === 'custom' && customProviderHost) {
		return undefined;
	}
	const provider = CLOUD_PROVIDERS.find((p) => p.id === selectedProvider);
	return provider?.cloudUrl;
});

// Check if remote config has changed
const hasRemoteConfigChanged = $derived(
	remoteKey !== currentRemoteKey ||
		selectedProvider !== currentProvider ||
		(selectedProvider === 'custom' &&
			(customProviderName !== (currentCustomProvider?.name ?? '') ||
				customProviderHost !== (currentCustomProvider?.host ?? ''))),
);

// Track if initial sync has happened
let initialSyncDone = $state(false);

// Sync remoteKey and provider with config only on initial load
$effect(() => {
	const config = getConfig();
	if (!config) return;

	// Only sync on initial load
	if (!initialSyncDone) {
		remoteKey = config.remote_key ?? '';
		selectedProvider = config.remote_provider ?? 'ceralive';

		const configCustomProvider = config.custom_provider;
		if (configCustomProvider) {
			customProviderName = configCustomProvider.name ?? '';
			customProviderHost = configCustomProvider.host ?? '';
			customProviderSecure = configCustomProvider.secure ?? true;
		}

		initialSyncDone = true;
	}
});

// Save remote config handler
function handleSaveRemoteConfig() {
	const customProvider =
		selectedProvider === 'custom'
			? {
					name: customProviderName || 'Custom',
					host: customProviderHost,
					path: '/ws/remote',
					secure: customProviderSecure,
				}
			: undefined;

	saveRemoteConfig({
		remote_key: remoteKey,
		provider: selectedProvider,
		custom_provider: customProvider,
	});

	toast.success($LL.advanced.remoteConfigSaved?.() ?? 'Remote configuration saved');
}

// Handle SSH password change notification
$effect(() => {
	const configMessage = getConfig();
	if (sshPasswordChanged && configMessage?.ssh_pass && lastSshPassword !== configMessage.ssh_pass) {
		toast.success($LL.advanced.passwordCopied(), {
			description: $LL.advanced.passwordCopiedDesc(),
		});
		sshPasswordChanged = false;
	}
	lastSshPassword = configMessage?.ssh_pass ?? '';
});
</script>

<div class="from-background via-background to-accent/5 min-h-screen bg-gradient-to-br">
	<div class="container mx-auto max-w-7xl px-4 py-6">
		<!-- Header Section -->
		<div class="mb-8">
			<h1 class="text-3xl font-bold tracking-tight">{$LL.advanced.systemSettings()}</h1>
			<p class="text-muted-foreground mt-2">
				{$LL.advanced.systemDescription()}
			</p>
		</div>

		<!-- Responsive Grid Layout -->
		<div class="grid gap-6 lg:grid-cols-2 lg:items-start">
			<!-- System Settings Card -->
			<Card.Root
				class="bg-card/50 gap-0 overflow-hidden border border-blue-500/30 py-0 shadow-lg backdrop-blur-sm"
			>
				<div class="h-1 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
				<Card.Header class="border-b pt-6 pb-6">
					<div class="flex items-center space-x-4">
						<div
							class="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500 shadow-sm"
						>
							<Settings class="h-6 w-6 text-white" />
						</div>
						<div class="flex-1">
							<Card.Title class="text-xl font-semibold">
								{$LL.advanced.systemSettings()}
							</Card.Title>
							<p class="text-muted-foreground mt-1 text-sm">
								{$LL.advanced.coreSystemConfiguration()}
							</p>
						</div>
					</div>
				</Card.Header>
				<Card.Content class="space-y-6 pt-6 pb-6">
					<!-- LAN Password Section -->
					<div class="space-y-3">
						<div class="space-y-2">
							<Label class="text-sm font-medium" for="lanPassword">
								{$LL.advanced.lanPassword()}
							</Label>
							<p class="text-muted-foreground text-sm">
								{$LL.advanced.lanPasswordTooltip()}
							</p>
							{#if password.length > 0 && password.length < 8}
								<p class="text-destructive flex items-center gap-2 text-sm">
									<span class="bg-destructive h-2 w-2 rounded-full"></span>
									{$LL.advanced.minLength()}
								</p>
							{/if}
						</div>
						<div class="relative">
							<Input
								id="lanPassword"
								class="bg-background/50 border-muted-foreground/20 focus:border-primary h-11 pr-24 transition-colors"
								placeholder={$LL.advanced.newPassword()}
								type={showPassword ? 'text' : 'password'}
								bind:value={password}
							/>
							<div class="absolute inset-y-0 right-2 flex items-center gap-1">
								<Button
									class="hover:bg-muted/50 h-8 w-8 rounded-md p-0"
									onclick={() => (showPassword = !showPassword)}
									size="sm"
									variant="ghost"
								>
									{#if showPassword}
										<EyeOff class="h-4 w-4" />
									{:else}
										<Eye class="h-4 w-4" />
									{/if}
								</Button>
								<Button
									class="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-3 shadow-sm"
									disabled={password.length < 8}
									onclick={() => {
										savePassword(password);
										password = '';
									}}
									size="sm"
								>
									{$LL.advanced.save()}
								</Button>
							</div>
						</div>
					</div>

					<!-- Cloud Remote Section -->
					<div class="space-y-4">
						<div class="flex items-center gap-3 border-b pb-2">
							<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500">
								<Cloud class="h-4 w-4 text-white" />
							</div>
							<div>
								<h3 class="font-semibold">{$LL.advanced.cloudRemote?.() ?? 'Cloud Remote'}</h3>
								<p class="text-muted-foreground text-sm">
									{$LL.advanced.cloudRemoteDescription?.() ?? 'Configure remote cloud management'}
								</p>
							</div>
						</div>

						<!-- Provider Selection -->
						<div class="space-y-2">
							<Label class="text-sm font-medium" for="cloudProvider">
								{$LL.advanced.cloudProvider?.() ?? 'Cloud Provider'}
							</Label>
							<Select.Root type="single" bind:value={selectedProvider}>
								<Select.Trigger class="bg-background/50 border-muted-foreground/20 w-full">
									{CLOUD_PROVIDERS.find((p) => p.id === selectedProvider)?.name ??
										'Select provider'}
								</Select.Trigger>
								<Select.Content>
									{#each CLOUD_PROVIDERS as provider}
										<Select.Item value={provider.id}>{provider.name}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>

						<!-- Custom Provider Fields -->
						{#if selectedProvider === 'custom'}
							<div class="bg-muted/30 space-y-3 rounded-lg border p-4">
								<div class="space-y-2">
									<Label class="text-sm font-medium" for="customProviderName">
										{$LL.advanced.providerName?.() ?? 'Provider Name'}
									</Label>
									<Input
										id="customProviderName"
										class="bg-background/50 border-muted-foreground/20"
										placeholder="My Custom Cloud"
										bind:value={customProviderName}
									/>
								</div>
								<div class="space-y-2">
									<Label class="text-sm font-medium" for="customProviderHost">
										{$LL.advanced.providerHost?.() ?? 'WebSocket Host'}
									</Label>
									<Input
										id="customProviderHost"
										class="bg-background/50 border-muted-foreground/20"
										placeholder="remote.example.com"
										bind:value={customProviderHost}
									/>
									<p class="text-muted-foreground text-xs">
										{$LL.advanced.providerHostHint?.() ??
											'Enter the WebSocket server hostname (without protocol)'}
									</p>
								</div>
								<div class="flex items-center gap-2">
									<input
										id="customProviderSecure"
										class="h-4 w-4 rounded"
										type="checkbox"
										bind:checked={customProviderSecure}
									/>
									<Label class="text-sm" for="customProviderSecure">
										{$LL.advanced.useSecureConnection?.() ?? 'Use secure connection (wss)'}
									</Label>
								</div>
							</div>
						{/if}

						<!-- Cloud URL Link -->
						{#if currentCloudUrl()}
							<a
								class="text-primary hover:text-primary/80 inline-flex items-center text-sm font-medium transition-colors hover:underline"
								href={currentCloudUrl()}
								rel="noopener noreferrer"
								target="_blank"
							>
								{currentCloudUrl()}
								<svg class="ml-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
									/>
								</svg>
							</a>
						{/if}

						<!-- Remote Key Input -->
						<div class="space-y-2">
							<Label class="text-sm font-medium" for="remoteKey">
								{$LL.advanced.cloudRemoteKey()}
							</Label>
							<p class="text-muted-foreground text-sm">
								{$LL.advanced.cloudRemoteKeyTooltip()}
							</p>
						</div>
						<div class="relative">
							<Input
								id="remoteKey"
								name="remote-key"
								class="bg-background/50 border-muted-foreground/20 focus:border-primary h-11 pr-24 transition-colors"
								type={showRemoteKey ? 'text' : 'password'}
								bind:value={remoteKey}
							/>
							<div class="absolute inset-y-0 right-2 flex items-center gap-1">
								<Button
									class="hover:bg-muted/50 h-8 w-8 rounded-md p-0"
									onclick={() => (showRemoteKey = !showRemoteKey)}
									size="sm"
									variant="ghost"
								>
									{#if showRemoteKey}
										<EyeOff class="h-4 w-4" />
									{:else}
										<Eye class="h-4 w-4" />
									{/if}
								</Button>
								<Button
									class="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-3 shadow-sm"
									disabled={!hasRemoteConfigChanged ||
										(selectedProvider === 'custom' && !customProviderHost)}
									onclick={handleSaveRemoteConfig}
									size="sm"
								>
									{$LL.advanced.save()}
								</Button>
							</div>
						</div>
					</div>

					<!-- System Actions Section -->
					<div class="space-y-4">
						<div class="flex items-center gap-3 border-b pb-2">
							<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500">
								<svg
									class="h-4 w-4 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										d="M13 10V3L4 14h7v7l9-11h-7z"
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
									/>
								</svg>
							</div>
							<div>
								<h3 class="text-sm font-semibold">
									{$LL.advanced.systemActions()}
								</h3>
								<p class="text-muted-foreground text-xs">
									{$LL.advanced.systemActionsDescription()}
								</p>
							</div>
						</div>
						<div class="grid gap-4 sm:grid-cols-2">
							<!-- Reboot System Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-50 to-orange-50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-amber-500/30 dark:from-amber-950/30 dark:to-orange-950/20"
							>
								<!-- Status bar -->
								<div
									class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 to-orange-500"
								></div>
								<div class="flex flex-1 items-start gap-3 pt-1">
									<div
										class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 shadow-md shadow-amber-500/20"
									>
										<RotateCcw class="h-5 w-5 text-white" />
									</div>
									<div class="min-w-0 flex-1">
										<h4 class="font-semibold text-amber-900 dark:text-amber-100">
											{$LL.advanced.reboot()}
										</h4>
										<p class="text-xs text-amber-700/70 dark:text-amber-300/70">
											{$LL.advanced.rebootDescription()}
										</p>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.reboot()}
										confirmButtonText={$LL.advanced.reboot()}
										extraButtonClasses="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 border-0 shadow-lg shadow-amber-500/25 text-white font-medium h-10 text-sm justify-center"
										iconPosition="left"
										onconfirm={reboot}
									>
										{#snippet icon()}
											<RotateCcw class="h-4 w-4" />
										{/snippet}
										{#snippet dialogTitle()}
											{$LL.advanced.reboot()}
										{/snippet}
										{#snippet description()}
											{$LL.advanced.confirmReboot()}
										{/snippet}
									</SimpleAlertDialog>
								</div>
							</div>

							<!-- Power Off System Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-red-500/30 bg-gradient-to-br from-red-50 to-rose-50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-red-500/30 dark:from-red-950/30 dark:to-rose-950/20"
							>
								<!-- Status bar -->
								<div
									class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 to-rose-500"
								></div>
								<div class="flex flex-1 items-start gap-3 pt-1">
									<div
										class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-red-500 to-rose-500 shadow-md shadow-red-500/20"
									>
										<PowerOff class="h-5 w-5 text-white" />
									</div>
									<div class="min-w-0 flex-1">
										<h4 class="font-semibold text-red-900 dark:text-red-100">
											{$LL.advanced.powerOff()}
										</h4>
										<p class="text-xs text-red-700/70 dark:text-red-300/70">
											{$LL.advanced.powerOffDescription()}
										</p>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.powerOff()}
										confirmButtonText={$LL.advanced.powerOff()}
										extraButtonClasses="w-full bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-600 hover:to-rose-600 border-0 shadow-lg shadow-red-500/25 text-white font-medium h-10 text-sm justify-center"
										iconPosition="left"
										onconfirm={powerOff}
									>
										{#snippet icon()}
											<PowerOff class="h-4 w-4" />
										{/snippet}
										{#snippet dialogTitle()}
											{$LL.advanced.powerOff()}
										{/snippet}
										{#snippet description()}
											{$LL.advanced.confirmPowerOff()}
										{/snippet}
									</SimpleAlertDialog>
								</div>
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<!-- Developer Options Card -->
			<Card.Root
				class="bg-card/50 gap-0 overflow-hidden border border-purple-500/30 py-0 shadow-lg backdrop-blur-sm"
			>
				<div class="h-1 bg-gradient-to-r from-purple-500 to-violet-600"></div>
				<Card.Header class="border-b pt-6 pb-6">
					<div class="flex items-center space-x-4">
						<div
							class="grid h-12 w-12 place-items-center rounded-lg bg-gradient-to-br from-purple-500 to-violet-600 shadow-md shadow-purple-500/20"
						>
							<Hammer class="h-6 w-6 text-white" />
						</div>
						<div class="flex-1">
							<Card.Title class="text-xl font-semibold">
								{$LL.advanced.developerOptions()}
							</Card.Title>
							<p class="text-muted-foreground mt-1 text-sm">
								{$LL.advanced.developmentToolsAccess()}
							</p>
						</div>
					</div>
				</Card.Header>
				<Card.Content class="space-y-6 pt-6 pb-6">
					<!-- SSH Configuration Section -->
					<div class="space-y-3">
						<div class="space-y-2">
							<Label class="text-sm font-medium" for="sshPassword">
								{$LL.advanced.sshPassword({ sshUser })}
							</Label>
							<p class="text-muted-foreground text-sm">
								{$LL.advanced.sshPasswordTooltip()}
							</p>
							<div
								class={cn(
									'flex items-center justify-between rounded-lg border px-4 py-3',
									sshStatus
										? 'border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20'
										: 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50',
								)}
							>
								<div class="flex items-center gap-2 text-sm">
									<div
										class={cn(
											'h-2.5 w-2.5 rounded-full',
											sshStatus ? 'animate-pulse bg-emerald-500' : 'bg-slate-400',
										)}
									></div>
									<span class="font-medium">{$LL.advanced.sshServer()}:</span>
								</div>
								<span
									class={cn(
										'rounded-md px-2.5 py-1 text-xs font-semibold',
										sshStatus
											? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400'
											: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400',
									)}
								>
									{sshStatus ? $LL.advanced.active() : $LL.advanced.inactive()}
								</span>
							</div>
						</div>
						<div class="relative">
							<Input
								id="sshPassword"
								class="bg-background/50 border-muted-foreground/20 focus:border-primary h-11 pr-40 transition-colors"
								placeholder={$LL.advanced.sshPasswordPlaceholder()}
								readonly
								type={showSSHPassword ? 'text' : 'password'}
								value={sshPassword}
							/>
							<div class="absolute inset-y-0 right-2 flex items-center gap-1">
								<Button
									class="hover:bg-muted/50 h-8 w-8 rounded-md p-0"
									onclick={async () => {
										console.log(
											'🔐 Attempting to copy SSH password:',
											sshPassword ? 'Password available' : 'No password',
										);
										try {
											if (!sshPassword) {
												throw new Error('No SSH password available to copy');
											}
											await navigator.clipboard.writeText(sshPassword);
											console.log('✅ SSH password copied to clipboard successfully');
											toast.success($LL.advanced.passwordCopied(), {
												description: $LL.advanced.passwordCopiedDesc(),
											});
										} catch (error) {
											console.error('Failed to copy password to clipboard:', error);
											// Fallback: Select the input text for manual copying
											const input = document.getElementById('sshPassword') as HTMLInputElement;
											if (input) {
												input.select();
												input.setSelectionRange(0, 99999); // For mobile devices
												try {
													document.execCommand('copy');
													toast.success($LL.advanced.passwordCopied(), {
														description: 'Password selected for copying (manual)',
													});
												} catch (fallbackError) {
													toast.error('Copy Failed', {
														description:
															'Unable to copy password. Please select and copy manually.',
													});
												}
											} else {
												toast.error('Copy Failed', {
													description: 'Clipboard access denied. Please copy manually.',
												});
											}
										}
									}}
									size="sm"
									variant="ghost"
								>
									<Copy class="h-4 w-4" />
								</Button>
								<Button
									class="hover:bg-muted/50 h-8 w-8 rounded-md p-0"
									onclick={() => (showSSHPassword = !showSSHPassword)}
									size="sm"
									variant="ghost"
								>
									{#if showSSHPassword}
										<EyeOff class="h-4 w-4" />
									{:else}
										<Eye class="h-4 w-4" />
									{/if}
								</Button>
								<Button
									class="h-8 border-0 bg-gradient-to-r from-red-500 to-rose-600 px-3 shadow-sm hover:from-red-600 hover:to-rose-700"
									onclick={() => {
										resetSSHPasword();
										sshPasswordChanged = true;
									}}
									size="sm"
									variant="destructive"
								>
									{$LL.advanced.reset()}
								</Button>
							</div>
						</div>

						<!-- SSH Toggle Button -->
						<Button
							class={cn(
								'h-11 w-full justify-start border-0 font-medium shadow-md transition-all duration-200',
								sshStatus
									? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700'
									: 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:from-emerald-600 hover:to-teal-700',
							)}
							onclick={sshStatus ? stopSSH : startSSH}
						>
							<div class="flex items-center gap-3">
								<div
									class={cn('h-3 w-3 rounded-full shadow-sm', 'bg-white/90 shadow-white/30')}
								></div>
								{sshStatus ? $LL.advanced.stopSSH() : $LL.advanced.startSSH()}
							</div>
						</Button>
					</div>

					<!-- Log Management Section -->
					<div class="space-y-4 border-t pt-6">
						<div class="flex items-center gap-3 pb-2">
							<div
								class="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-purple-500 to-violet-600"
							>
								<Logs class="h-4 w-4 text-white" />
							</div>
							<div>
								<h3 class="text-sm font-semibold">
									{$LL.advanced.logManagement()}
								</h3>
								<p class="text-muted-foreground text-xs">
									{$LL.advanced.logManagementDescription()}
								</p>
							</div>
						</div>
						<div class="grid gap-4 sm:grid-cols-2">
							<!-- CERALIVE Log Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-50 to-violet-50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-purple-500/30 dark:from-purple-950/30 dark:to-violet-950/20"
							>
								<!-- Status bar -->
								<div
									class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-purple-500 to-violet-500"
								></div>
								<div class="flex flex-1 items-start gap-3 pt-1">
									<div
										class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-purple-500 to-violet-500 shadow-md shadow-purple-500/20"
									>
										<svg
											class="h-5 w-5 text-white"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
											/>
										</svg>
									</div>
									<div class="min-w-0 flex-1">
										<h4 class="font-semibold text-purple-900 dark:text-purple-100">CERALIVE Log</h4>
										<p class="text-xs text-purple-700/70 dark:text-purple-300/70">
											{$LL.advanced.applicationLogsDescription()}
										</p>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.download()}
										confirmButtonText={$LL.advanced.download()}
										extraButtonClasses="w-full bg-gradient-to-r from-purple-500 to-violet-500 hover:from-purple-600 hover:to-violet-600 border-0 shadow-lg shadow-purple-500/25 text-white font-medium h-10 text-sm justify-center"
										iconPosition="left"
										onconfirm={getDeviceLog}
									>
										{#snippet icon()}
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
												/>
											</svg>
										{/snippet}
										{#snippet dialogTitle()}
											{$LL.advanced.downloadDeviceLog()}
										{/snippet}
										{#snippet description()}
											{$LL.advanced.confirmDeviceLog()}
										{/snippet}
									</SimpleAlertDialog>
								</div>
							</div>

							<!-- System Log Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-50 to-violet-50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-purple-500/30 dark:from-purple-950/30 dark:to-violet-950/20"
							>
								<!-- Status bar -->
								<div
									class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-purple-500 to-violet-500"
								></div>
								<div class="flex flex-1 items-start gap-3 pt-1">
									<div
										class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-purple-500 to-violet-500 shadow-md shadow-purple-500/20"
									>
										<svg
											class="h-5 w-5 text-white"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
											/>
										</svg>
									</div>
									<div class="min-w-0 flex-1">
										<h4 class="font-semibold text-purple-900 dark:text-purple-100">System Log</h4>
										<p class="text-xs text-purple-700/70 dark:text-purple-300/70">
											{$LL.advanced.systemLogsDescription()}
										</p>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.download()}
										confirmButtonText={$LL.advanced.download()}
										extraButtonClasses="w-full bg-gradient-to-r from-purple-500 to-violet-500 hover:from-purple-600 hover:to-violet-600 border-0 shadow-lg shadow-purple-500/25 text-white font-medium h-10 text-sm justify-center"
										iconPosition="left"
										onconfirm={getSystemLog}
									>
										{#snippet icon()}
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
												/>
											</svg>
										{/snippet}
										{#snippet dialogTitle()}
											{$LL.advanced.downloadSystemLog()}
										{/snippet}
										{#snippet description()}
											{$LL.advanced.confirmSystemLog()}
										{/snippet}
									</SimpleAlertDialog>
								</div>
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
		</div>

		<!-- Version Information Status Bar -->
		{#if revisions}
			<div class="border-t bg-slate-50/80 backdrop-blur-md dark:bg-slate-900/80">
				<div class="container mx-auto max-w-7xl px-4 py-5">
					<div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
						<div class="flex items-center gap-4">
							<div class="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 shadow-sm">
								<svg
									class="h-5 w-5 text-emerald-600 dark:text-emerald-400"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
									/>
								</svg>
							</div>
							<div>
								<p class="text-base font-semibold text-emerald-900 dark:text-emerald-100">
									{$LL.advanced.versionInformation()}
								</p>
								<p class="text-sm font-medium text-emerald-600/70 dark:text-emerald-300/70">
									{$LL.advanced.systemComponentsVersions()}
								</p>
							</div>
						</div>
						<div class="grid grid-cols-2 gap-6 text-sm lg:grid-cols-4">
							<div class="bg-card rounded-lg border p-3">
								<p class="text-muted-foreground mb-1 text-xs font-medium">CeraLive</p>
								<p class="font-mono font-semibold">
									{revisions.ceralive}
								</p>
							</div>
							<div
								class="rounded-lg border border-slate-200/50 bg-white/60 p-3 dark:border-slate-700/50 dark:bg-slate-800/60"
							>
								<p class="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">Belacoder</p>
								<p class="font-mono font-semibold text-slate-900 dark:text-slate-100">
									{revisions.belacoder}
								</p>
							</div>
							<div
								class="rounded-lg border border-slate-200/50 bg-white/60 p-3 dark:border-slate-700/50 dark:bg-slate-800/60"
							>
								<p class="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">SRTLA</p>
								<p class="font-mono font-semibold text-slate-900 dark:text-slate-100">
									{revisions.srtla}
								</p>
							</div>
							<div
								class="rounded-lg border border-slate-200/50 bg-white/60 p-3 dark:border-slate-700/50 dark:bg-slate-800/60"
							>
								<p class="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">
									CERALIVE Image
								</p>
								<p class="font-mono font-semibold text-slate-900 dark:text-slate-100">
									{revisions['CERALIVE image']}
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
