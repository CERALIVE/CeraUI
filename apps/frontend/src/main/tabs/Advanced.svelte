<script lang="ts">
import { Copy, Eye, EyeOff, Hammer, Logs, PowerOff, RotateCcw, Settings } from '@lucide/svelte';
import { LL } from "@ceraui/i18n/svelte";
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import {
	getBelaboxLog,
	getSystemLog,
	powerOff,
	reboot,
	resetSSHPasword,
	savePassword,
	saveRemoteKey,
	startSSH,
	stopSSH,
} from '$lib/helpers/SystemHelper';
import { ConfigMessages, RevisionsMessages, StatusMessages } from '$lib/stores/websocket-store';
import type { RevisionsMessage } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

let currentRemoteKey = $state('');
let remoteKey = $state('');

let showPassword = $state(false);
let showRemoteKey = $state(false);
let showSSHPassword = $state(false);

let password = $state('');
let sshPassword = $state('');
let sshStatus = $state(false);
let sshUser = $state('');
let sshPasswordChanged = $state(false);

ConfigMessages.subscribe((config) => {
	currentRemoteKey = config?.remote_key ?? '';
	remoteKey = config?.remote_key ?? '';
});

let revisions = $state<RevisionsMessage | undefined>();
RevisionsMessages.subscribe((revisionMessage) => {
	revisions = revisionMessage;
});

ConfigMessages.subscribe((configMessage) => {
	if (sshPasswordChanged && configMessage.ssh_pass && sshPassword !== configMessage.ssh_pass) {
		toast.success($LL.advanced.passwordCopied(), {
			description: $LL.advanced.passwordCopiedDesc(),
		});
		sshPasswordChanged = false;
	}
	sshPassword = configMessage?.ssh_pass ?? '';
});
StatusMessages.subscribe((statusMessage) => {
	sshStatus = statusMessage?.ssh.active ?? false;
	sshUser = statusMessage?.ssh.user ?? '';
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
			<Card.Root class="bg-card/50 border-0 shadow-lg backdrop-blur-sm">
				<Card.Header
					class="border-b bg-gradient-to-r from-blue-50/50 to-blue-100/50 pb-6 dark:from-blue-950/20 dark:to-blue-900/20"
				>
					<div class="flex items-center space-x-4">
						<div class="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 shadow-sm">
							<Settings class="h-6 w-6 text-blue-600 dark:text-blue-400" />
						</div>
						<div class="flex-1">
							<Card.Title class="text-xl font-bold text-blue-900 dark:text-blue-100">
								{$LL.advanced.systemSettings()}
							</Card.Title>
							<p class="mt-1 text-sm font-medium text-blue-600/70 dark:text-blue-300/70">
								{$LL.advanced.coreSystemConfiguration()}
							</p>
						</div>
					</div>
				</Card.Header>
				<Card.Content class="space-y-6">
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

					<!-- Cloud Remote Key Section -->
					<div class="space-y-3">
						<div class="space-y-2">
							<Label class="text-sm font-medium" for="remoteKey">
								{$LL.advanced.cloudRemoteKey()}
							</Label>
							<p class="text-muted-foreground text-sm">
								{$LL.advanced.cloudRemoteKeyTooltip()}
							</p>
							<a
								class="text-primary hover:text-primary/80 inline-flex items-center text-sm font-medium transition-colors hover:underline"
								href="https://cloud.belabox.net"
								rel="noopener noreferrer"
								target="_blank"
							>
								https://cloud.belabox.net
								<svg class="ml-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
									/>
								</svg>
							</a>
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
									disabled={remoteKey === currentRemoteKey}
									onclick={() => {
										saveRemoteKey(remoteKey);
									}}
									size="sm"
								>
									{$LL.advanced.save()}
								</Button>
							</div>
						</div>
					</div>

					<!-- System Actions Section -->
					<div class="space-y-4">
						<div
							class="flex items-center gap-3 border-b border-blue-200/50 pb-2 dark:border-blue-800/50"
						>
							<div class="rounded-lg bg-blue-500/10 p-2">
								<svg
									class="h-4 w-4 text-blue-600 dark:text-blue-400"
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
								<h3 class="text-sm font-semibold text-blue-900 dark:text-blue-100">
									{$LL.advanced.systemActions()}
								</h3>
								<p class="text-xs text-blue-600/70 dark:text-blue-300/70">
									{$LL.advanced.systemActionsDescription()}
								</p>
							</div>
						</div>
						<div class="grid gap-4 sm:grid-cols-2">
							<!-- Reboot System Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-yellow-200/50 bg-gradient-to-br from-yellow-50/50 to-yellow-100/50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-yellow-800/50 dark:from-yellow-950/20 dark:to-yellow-900/20"
							>
								<div class="flex flex-1 items-start justify-between">
									<div class="flex items-center gap-3">
										<div class="rounded-lg bg-yellow-500/10 p-2 shadow-sm">
											<RotateCcw class="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
										</div>
										<div>
											<h4 class="font-semibold text-yellow-900 dark:text-yellow-100">
												{$LL.advanced.reboot()}
											</h4>
											<p class="text-xs text-yellow-600/70 dark:text-yellow-300/70">
												{$LL.advanced.rebootDescription()}
											</p>
										</div>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.reboot()}
										confirmButtonText={$LL.advanced.reboot()}
										extraButtonClasses="w-full bg-gradient-to-r from-yellow-500 to-yellow-600 hover:from-yellow-600 hover:to-yellow-700 border-0 shadow-sm text-white font-medium h-9 text-sm justify-center"
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
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-red-200/50 bg-gradient-to-br from-red-50/50 to-red-100/50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-red-800/50 dark:from-red-950/20 dark:to-red-900/20"
							>
								<div class="flex flex-1 items-start justify-between">
									<div class="flex items-center gap-3">
										<div class="rounded-lg bg-red-500/10 p-2 shadow-sm">
											<PowerOff class="h-5 w-5 text-red-600 dark:text-red-400" />
										</div>
										<div>
											<h4 class="font-semibold text-red-900 dark:text-red-100">
												{$LL.advanced.powerOff()}
											</h4>
											<p class="text-xs text-red-600/70 dark:text-red-300/70">
												{$LL.advanced.powerOffDescription()}
											</p>
										</div>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.powerOff()}
										confirmButtonText={$LL.advanced.powerOff()}
										extraButtonClasses="w-full bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 border-0 shadow-sm text-white font-medium h-9 text-sm justify-center"
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
			<Card.Root class="bg-card/50 border-0 shadow-lg backdrop-blur-sm">
				<Card.Header
					class="border-b bg-gradient-to-r from-purple-50/50 to-purple-100/50 pb-6 dark:from-purple-950/20 dark:to-purple-900/20"
				>
					<div class="flex items-center space-x-4">
						<div class="rounded-xl border border-purple-500/20 bg-purple-500/10 p-3 shadow-sm">
							<Hammer class="h-6 w-6 text-purple-600 dark:text-purple-400" />
						</div>
						<div class="flex-1">
							<Card.Title class="text-xl font-bold text-purple-900 dark:text-purple-100">
								{$LL.advanced.developerOptions()}
							</Card.Title>
							<p class="mt-1 text-sm font-medium text-purple-600/70 dark:text-purple-300/70">
								{$LL.advanced.developmentToolsAccess()}
							</p>
						</div>
					</div>
				</Card.Header>
				<Card.Content class="space-y-6">
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
								class="rounded-xl border border-purple-200/50 bg-gradient-to-r from-purple-50/30 to-purple-100/30 p-4 shadow-sm dark:border-purple-800/50 dark:from-purple-950/20 dark:to-purple-900/20"
							>
								<div class="flex items-center gap-3 text-sm">
									<div class="flex items-center gap-2">
										<div
											class={cn(
												'h-3 w-3 rounded-full shadow-sm',
												sshStatus
													? 'bg-green-500 shadow-green-500/30'
													: 'bg-gray-400 shadow-gray-400/30',
											)}
										></div>
										<span class="font-semibold text-purple-900 dark:text-purple-100"
											>{$LL.advanced.sshServer()}:</span
										>
									</div>
									<span
										class={cn(
											'rounded-md px-2 py-1 text-xs font-medium',
											sshStatus
												? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
												: 'bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400',
										)}
									>
										{sshStatus ? $LL.advanced.active() : $LL.advanced.inactive()}
									</span>
								</div>
							</div>
						</div>
						<div class="relative">
							<Input
								id="sshPassword"
								class="bg-background/50 border-muted-foreground/20 focus:border-primary h-11 pr-40 transition-colors"
								placeholder={$LL.advanced.sshPasswordPlaceholder()}
								readonly
								type={showSSHPassword ? 'text' : 'password'}
								bind:value={sshPassword}
							/>
							<div class="absolute inset-y-0 right-2 flex items-center gap-1">
								<Button
									class="hover:bg-muted/50 h-8 w-8 rounded-md p-0"
									onclick={() => {
										navigator.clipboard.writeText(sshPassword).then(() => {
											toast.info($LL.advanced.passwordCopied(), {
												description: $LL.advanced.passwordCopiedDesc(),
											});
										});
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
									class="h-8 border-0 bg-gradient-to-r from-red-500 to-red-600 px-3 shadow-sm hover:from-red-600 hover:to-red-700"
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
									? 'bg-gradient-to-r from-yellow-500 to-yellow-600 text-white hover:from-yellow-600 hover:to-yellow-700'
									: 'bg-gradient-to-r from-green-500 to-green-600 text-white hover:from-green-600 hover:to-green-700',
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
					<div class="space-y-4 border-t border-purple-200/30 pt-6 dark:border-purple-800/30">
						<div
							class="flex items-center gap-3 border-b border-purple-200/50 pb-2 dark:border-purple-800/50"
						>
							<div class="rounded-lg bg-purple-500/10 p-2">
								<Logs class="h-4 w-4 text-purple-600 dark:text-purple-400" />
							</div>
							<div>
								<h3 class="text-sm font-semibold text-purple-900 dark:text-purple-100">
									{$LL.advanced.logManagement()}
								</h3>
								<p class="text-xs text-purple-600/70 dark:text-purple-300/70">
									{$LL.advanced.logManagementDescription()}
								</p>
							</div>
						</div>
						<div class="grid gap-4 sm:grid-cols-2">
							<!-- BELABOX Log Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-purple-200/50 bg-gradient-to-br from-purple-50/50 to-purple-100/50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-purple-800/50 dark:from-purple-950/20 dark:to-purple-900/20"
							>
								<div class="flex flex-1 items-start justify-between">
									<div class="flex items-center gap-3">
										<div class="rounded-lg bg-purple-500/10 p-2 shadow-sm">
											<svg
												class="h-5 w-5 text-purple-600 dark:text-purple-400"
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
										<div>
											<h4 class="font-semibold text-purple-900 dark:text-purple-100">
												CERALIVE Log
											</h4>
											<p class="text-xs text-purple-600/70 dark:text-purple-300/70">
												{$LL.advanced.applicationLogsDescription()}
											</p>
										</div>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.download()}
										confirmButtonText={$LL.advanced.download()}
										extraButtonClasses="w-full bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 border-0 shadow-sm text-white font-medium h-9 text-sm justify-center"
										iconPosition="left"
										onconfirm={getBelaboxLog}
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
											{$LL.advanced.downloadBelaboxLog()}
										{/snippet}
										{#snippet description()}
											{$LL.advanced.confirmBelaboxLog()}
										{/snippet}
									</SimpleAlertDialog>
								</div>
							</div>

							<!-- System Log Card -->
							<div
								class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-purple-200/50 bg-gradient-to-br from-purple-50/50 to-purple-100/50 p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-purple-800/50 dark:from-purple-950/20 dark:to-purple-900/20"
							>
								<div class="flex flex-1 items-start justify-between">
									<div class="flex items-center gap-3">
										<div class="rounded-lg bg-purple-500/10 p-2 shadow-sm">
											<svg
												class="h-5 w-5 text-purple-600 dark:text-purple-400"
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
										<div>
											<h4 class="font-semibold text-purple-900 dark:text-purple-100">System Log</h4>
											<p class="text-xs text-purple-600/70 dark:text-purple-300/70">
												{$LL.advanced.systemLogsDescription()}
											</p>
										</div>
									</div>
								</div>
								<div class="mt-4">
									<SimpleAlertDialog
										buttonText={$LL.advanced.download()}
										confirmButtonText={$LL.advanced.download()}
										extraButtonClasses="w-full bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 border-0 shadow-sm text-white font-medium h-9 text-sm justify-center"
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
			<div
				class="border-t border-gray-200/50 bg-gradient-to-r from-gray-50/80 to-gray-100/80 backdrop-blur-md dark:border-gray-800/50 dark:from-gray-900/80 dark:to-gray-800/80"
			>
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
							<div
								class="rounded-lg border border-gray-200/50 bg-white/60 p-3 dark:border-gray-700/50 dark:bg-gray-800/60"
							>
								<p class="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">BelaUI</p>
								<p class="font-mono font-semibold text-gray-900 dark:text-gray-100">
									{revisions.belaUI}
								</p>
							</div>
							<div
								class="rounded-lg border border-gray-200/50 bg-white/60 p-3 dark:border-gray-700/50 dark:bg-gray-800/60"
							>
								<p class="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">Belacoder</p>
								<p class="font-mono font-semibold text-gray-900 dark:text-gray-100">
									{revisions.belacoder}
								</p>
							</div>
							<div
								class="rounded-lg border border-gray-200/50 bg-white/60 p-3 dark:border-gray-700/50 dark:bg-gray-800/60"
							>
								<p class="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">SRTLA</p>
								<p class="font-mono font-semibold text-gray-900 dark:text-gray-100">
									{revisions.srtla}
								</p>
							</div>
							<div
								class="rounded-lg border border-gray-200/50 bg-white/60 p-3 dark:border-gray-700/50 dark:bg-gray-800/60"
							>
								<p class="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
									CERALIVE Image
								</p>
								<p class="font-mono font-semibold text-gray-900 dark:text-gray-100">
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
