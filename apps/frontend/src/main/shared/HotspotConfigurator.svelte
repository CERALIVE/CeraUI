<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import { AlertCircle, Bolt, CheckCircle, Eye, EyeOff, Smartphone, Wifi } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import { changeHotspotSettings, type WifiBand } from '$lib/helpers/NetworkHelper';
import type { ValueOf } from '$lib/types';
import { cn } from '$lib/utils';

const { deviceId, wifi }: { deviceId: number; wifi: ValueOf<StatusMessage['wifi']> } = $props();

// Enhanced state management with validation (initialized with defaults, synced via effect)
let hotspotProperties = $state({
	selectedChannel: 'auto' as string,
	password: '',
	deviceId: 0,
	name: '',
});

// Sync from props on initial mount
let formInitialized = false;
$effect.pre(() => {
	if (!formInitialized) {
		hotspotProperties = {
			selectedChannel: wifi.hotspot?.channel ?? 'auto',
			password: wifi.hotspot?.password || '',
			deviceId,
			name: wifi.hotspot?.name || '',
		};
		formInitialized = true;
	}
});

let showPassword = $state(false);
let isSubmitting = $state(false);

// Validation states
const validation = $derived({
	name: {
		isValid: hotspotProperties.name.length >= 3 && hotspotProperties.name.length <= 32,
		message:
			hotspotProperties.name.length < 3
				? $LL?.hotspotConfigurator?.validation?.nameMinLength?.() ||
					'Name must be at least 3 characters'
				: hotspotProperties.name.length > 32
					? $LL?.hotspotConfigurator?.validation?.nameMaxLength?.() ||
						'Name must be at most 32 characters'
					: '',
	},
	password: {
		isValid: hotspotProperties.password.length >= 8 && hotspotProperties.password.length <= 63,
		message:
			hotspotProperties.password.length < 8
				? $LL?.hotspotConfigurator?.validation?.passwordMinLength?.() ||
					'Password must be at least 8 characters'
				: hotspotProperties.password.length > 63
					? $LL?.hotspotConfigurator?.validation?.passwordMaxLength?.() ||
						'Password must be at most 63 characters'
					: '',
	},
});

const isFormValid = $derived(validation.name.isValid && validation.password.isValid);

const resetHotSpotProperties = () => {
	// Re-sync from current props when dialog is cancelled/reopened
	hotspotProperties = {
		selectedChannel: wifi.hotspot?.channel ?? 'auto',
		password: wifi.hotspot?.password || '',
		deviceId,
		name: wifi.hotspot?.name || '',
	};
	showPassword = false;
	isSubmitting = false;
};

const handleSubmit = async () => {
	if (!isFormValid) return;

	isSubmitting = true;
	try {
		await changeHotspotSettings({
			channel: hotspotProperties.selectedChannel ?? 'auto',
			deviceId: hotspotProperties.deviceId,
			name: hotspotProperties.name,
			password: hotspotProperties.password,
		});
		toast.success($LL.hotspotConfigurator.success.title(), {
			description: $LL.hotspotConfigurator.success.description(),
		});
	} catch (_error) {
		toast.error($LL.hotspotConfigurator.error.title(), {
			description: $LL.hotspotConfigurator.error.description(),
		});
	} finally {
		isSubmitting = false;
	}
};
</script>

<SimpleAlertDialog
	class="max-h-[90vh] max-w-[95vw] overflow-hidden sm:max-w-md lg:max-w-lg"
	buttonText={$LL.hotspotConfigurator.dialog.configHotspot()}
	confirmButtonText={isSubmitting
		? $LL.hotspotConfigurator.dialog.saving()
		: $LL.hotspotConfigurator.dialog.save()}
	disabledConfirmButton={!isFormValid || isSubmitting}
	extraButtonClasses="w-full gradient-primary text-primary-foreground font-medium shadow-lg shadow-primary/25 transition-all duration-300 transform hover:scale-[1.02]"
	oncancel={() => resetHotSpotProperties()}
	onconfirm={handleSubmit}
	title={$LL.hotspotConfigurator.dialog.configHotspot()}
>
	{#snippet icon()}
		<Bolt></Bolt>
	{/snippet}
	{#snippet dialogTitle()}
		{$LL.hotspotConfigurator.dialog.configureHotspot()}
	{/snippet}
	{#snippet description()}
		<div class="max-h-[60vh] space-y-6 overflow-y-auto p-1">
			<!-- Header Section -->
			<div class="space-y-2 text-center">
				<div
					class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl gradient-primary shadow-lg"
				>
					<Wifi class="h-8 w-8 text-primary-foreground" />
				</div>
				<p class="text-muted-foreground text-sm leading-relaxed">
					{$LL.hotspotConfigurator.help.description()}
				</p>
			</div>

			<!-- Network Name Field -->
			<div class="space-y-3">
				<Label class="text-foreground flex items-center gap-3 text-base font-semibold" for="name">
					<div
						class="flex h-8 w-8 items-center justify-center rounded-lg bg-status-info/15"
					>
						<Wifi class="h-4 w-4 text-status-info" />
					</div>
					{$LL.hotspotConfigurator.hotspot.name()}
				</Label>
				<div class="space-y-2">
					<div class="relative">
						<Input
							id="name"
							class={cn(
								'focus:ring-opacity-20 h-12 w-full rounded-xl border-2 px-4 text-base transition-all duration-300 focus:ring-4',
								!validation.name.isValid && hotspotProperties.name.length > 0
									? 'border-status-error bg-status-error/5 focus:border-status-error focus:ring-status-error/20'
									: validation.name.isValid && hotspotProperties.name.length > 0
										? 'border-primary bg-status-success/5 focus:border-primary focus:ring-primary/20'
										: 'border-border bg-muted focus:border-status-info focus:ring-status-info/20',
							)}
							autocapitalize="none"
							autocomplete="off"
							autocorrect="off"
							placeholder={$LL.hotspotConfigurator.hotspot.placeholderName()}
							bind:value={hotspotProperties.name}
						/>

						{#if hotspotProperties.name.length > 0}
							<div class="absolute top-1/2 right-3 -translate-y-1/2">
								{#if validation.name.isValid}
									<CheckCircle class="h-5 w-5 text-status-success" />
								{:else}
									<AlertCircle class="h-5 w-5 text-status-error" />
								{/if}
							</div>
						{/if}
					</div>

					{#if hotspotProperties.name.length > 0}
						<div
							class={cn(
								'flex items-center gap-2 rounded-lg p-3 text-sm font-medium',
								validation.name.isValid
									? 'bg-status-success/15 text-status-success'
									: 'bg-status-error/15 text-status-error',
							)}
						>
							{#if validation.name.isValid}
								<CheckCircle class="h-4 w-4" />
								<span>{$LL.hotspotConfigurator.validation.nameValid()}</span>
							{:else}
								<AlertCircle class="h-4 w-4" />
								<span>{validation.name.message}</span>
							{/if}
						</div>
					{:else}
						<div class="flex items-start gap-2 rounded-lg bg-status-info/5 p-3">
							<div
								class="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-status-info/15"
							>
								<span class="text-xs font-bold text-status-info">i</span>
							</div>
							<p class="text-sm leading-relaxed text-status-info">
								{$LL.hotspotConfigurator.help.nameHelp()}
							</p>
						</div>
					{/if}
				</div>
			</div>

			<!-- Password Field -->
			<div class="space-y-3">
				<Label
					class="text-foreground flex items-center gap-3 text-base font-semibold"
					for="hotspotPassword"
				>
					<div
						class="flex h-8 w-8 items-center justify-center rounded-lg bg-status-info/15"
					>
						<Smartphone class="h-4 w-4 text-status-info" />
					</div>
					{$LL.hotspotConfigurator.hotspot.password()}
				</Label>
				<div class="space-y-2">
					<div class="relative">
						<Input
							id="hotspotPassword"
							class={cn(
								'focus:ring-opacity-20 h-12 w-full rounded-xl border-2 px-4 pr-12 text-base transition-all duration-300 focus:ring-4',
								!validation.password.isValid && hotspotProperties.password.length > 0
									? 'border-status-error bg-status-error/5 focus:border-status-error focus:ring-status-error/20'
									: validation.password.isValid && hotspotProperties.password.length > 0
										? 'border-primary bg-status-success/5 focus:border-primary focus:ring-primary/20'
										: 'border-border bg-muted focus:border-status-info focus:ring-status-info/20',
							)}
							autocapitalize="none"
							autocomplete="off"
							autocorrect="off"
							placeholder={$LL.hotspotConfigurator.hotspot.placeholderPassword()}
							type={showPassword ? 'text' : 'password'}
							bind:value={hotspotProperties.password}
						/>

						<div class="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-2">
							{#if hotspotProperties.password.length > 0}
								{#if validation.password.isValid}
									<CheckCircle class="h-5 w-5 text-status-success" />
								{:else}
									<AlertCircle class="h-5 w-5 text-status-error" />
								{/if}
							{/if}
							<button
								class="text-muted-foreground hover:text-foreground rounded-lg p-1 transition-colors hover:bg-accent"
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

					{#if hotspotProperties.password.length > 0}
						<div
							class={cn(
								'flex items-center gap-2 rounded-lg p-3 text-sm font-medium',
								validation.password.isValid
									? 'bg-status-success/15 text-status-success'
									: 'bg-status-error/15 text-status-error',
							)}
						>
							{#if validation.password.isValid}
								<CheckCircle class="h-4 w-4" />
								<span
									>{$LL?.hotspotConfigurator?.validation?.passwordValid?.() ||
										'Password is valid'}</span
								>
							{:else}
								<AlertCircle class="h-4 w-4" />
								<span>{validation.password.message}</span>
							{/if}
						</div>
					{:else}
						<div class="flex items-start gap-2 rounded-lg bg-status-info/5 p-3">
							<div
								class="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-status-info/15"
							>
								<span class="text-xs font-bold text-status-info">!</span>
							</div>
							<p class="text-sm leading-relaxed text-status-info">
								{$LL.hotspotConfigurator.help.passwordHelp()}
							</p>
						</div>
					{/if}
				</div>
			</div>

			<!-- Channel Selection -->
			<div class="space-y-3">
				<Label
					class="text-foreground flex items-center gap-3 text-base font-semibold"
					for="channel"
				>
					<div
						class="flex h-8 w-8 items-center justify-center rounded-lg bg-status-warning/15"
					>
						<svg
							class="h-4 w-4 text-status-warning"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
							></path>
						</svg>
					</div>
					{$LL.hotspotConfigurator.hotspot.channel()}
				</Label>
				<div class="space-y-2">
					<Select.Root
						onValueChange={(selected) => {
							hotspotProperties.selectedChannel = selected as WifiBand;
						}}
						type="single"
						value={hotspotProperties.selectedChannel}
					>
						<Select.Trigger
							class="focus:ring-opacity-20 h-12 w-full rounded-xl border-2 border-border bg-muted px-4 text-base transition-all duration-300 focus:border-status-info focus:ring-4 focus:ring-status-info/20"
						>
							{hotspotProperties.selectedChannel
								? wifi.hotspot?.available_channels[hotspotProperties.selectedChannel].name
								: $LL.hotspotConfigurator.hotspot.selectChannel()}
						</Select.Trigger>
						<Select.Content
							class="rounded-xl border-2 border-border shadow-xl"
						>
							<Select.Group>
								{#if wifi.hotspot?.available_channels}
									{#each Object.entries(wifi.hotspot.available_channels) as [channelId, channel]}
										<Select.Item class="rounded-lg" label={channel.name} value={channelId}
										></Select.Item>
									{/each}
								{/if}
							</Select.Group>
						</Select.Content>
					</Select.Root>
					<div class="flex items-start gap-2 rounded-lg bg-status-warning/5 p-3">
						<div
							class="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-status-warning/30"
						>
							<span class="text-xs font-bold text-status-warning">✓</span>
						</div>
						<p class="text-sm leading-relaxed text-status-warning">
							{$LL.hotspotConfigurator.help.channelHelp()}
						</p>
					</div>
				</div>
			</div>

			<!-- Form Summary -->
			{#if !isFormValid && (hotspotProperties.name.length > 0 || hotspotProperties.password.length > 0)}
				<div
					class="rounded-xl border-2 border-status-warning/30 bg-status-warning/5 p-4"
				>
					<div class="flex items-start gap-3">
						<div
							class="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-status-warning"
						>
							<AlertCircle class="h-4 w-4 text-status-warning-foreground" />
						</div>
						<div>
							<h4 class="mb-1 font-semibold text-status-warning">
								{$LL.hotspotConfigurator.validation.almostThere()}
							</h4>
							<p class="text-sm leading-relaxed text-status-warning">
								{$LL.hotspotConfigurator.validation.formIncomplete()}
							</p>
						</div>
					</div>
				</div>
			{:else if isFormValid}
				<div
					class="rounded-xl border-2 border-status-success/30 bg-status-success/5 p-4"
				>
					<div class="flex items-center gap-3">
						<div class="flex h-6 w-6 items-center justify-center rounded-full bg-primary">
							<CheckCircle class="h-4 w-4 text-primary-foreground" />
						</div>
						<p class="font-semibold text-status-success">
							{$LL.hotspotConfigurator.validation.readyToSave()}
						</p>
					</div>
				</div>
			{/if}
		</div>
	{/snippet}
</SimpleAlertDialog>
