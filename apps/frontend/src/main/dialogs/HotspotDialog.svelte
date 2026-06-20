<!--
  HotspotDialog.svelte — configure / start / stop the device WiFi hotspot.

  Composes the shared AppDialog chrome (responsive Dialog ⇆ Sheet). Hotspot and
  the WiFi station are independent: this dialog never disables WiFi, it only
  drives the hotspot RPCs (configure / start / stop) for one WiFi interface.

  • Name / password / channel form, schema-driven bounds from ValidationAdapter
    (HOTSPOT_NAME_MIN/MAX, HOTSPOT_PASSWORD_MIN/MAX) — single source of truth.
  • Save  → rpc.wifi.hotspotConfigure, Start → rpc.wifi.hotspotStart,
    Stop → rpc.wifi.hotspotStop — all dispatched through `osCommand` (the single
    OS-op feedback path: keyed spinner, DEVICE_BUSY + failure toasts).
  • When the hotspot is active, a QR encoding the live credentials
    (WIFI:T:WPA;S:<name>;P:<password>;;) is rendered so phones can join by scan.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { WifiInterface } from '@ceraui/rpc/schemas';
import { Copy, Eye, EyeOff, Loader2, Power, QrCode, Router, Save, Wifi } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { networkConstraints } from '$lib/components/streaming';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { generateWifiQr } from '$lib/helpers/NetworkHelper';
import {
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { hotspotIsActive, hotspotToggleConfirmed } from '$lib/rpc/os-toggle-predicates';
import { cn } from '$lib/utils';

import ConnectPhoneSection from './hotspot/ConnectPhoneSection.svelte';

interface Props {
	open?: boolean;
	/** WiFi interface device key (record key in the wifi status map). */
	deviceId: string;
	/** The target WiFi interface — carries the live hotspot config when active. */
	iface?: WifiInterface;
}

let { open = $bindable(false), deviceId, iface }: Props = $props();

const bounds = networkConstraints.hotspot;

// The hotspot is "active" when the interface is currently broadcasting one.
const isActive = $derived(hotspotIsActive(iface));

// ── Keyed async-operation phases ──────────────────────────────────────────
// start/stop shares the `hotspot:${deviceId}` key with WifiSection's mode switch
// (T8) — the osCommand re-entry guard enforces a single hotspot op per device.
// configure uses a SEPARATE key so a save never collides with a start/stop.
const toggleKey = $derived(`hotspot:${deviceId}`);
const configKey = $derived(`hotspot-config:${deviceId}`);
const toggling = $derived(getOperationPhase(toggleKey) === 'pending');
const configuring = $derived(getOperationPhase(configKey) === 'pending');

// Local intent for the pending start/stop: the confirm $effect flips the op to
// `confirmed` the moment the authoritative snapshot reports the target mode.
let toggleTarget = $state<'hotspot' | 'station' | null>(null);

// ── Form state (synced once from props; user edits are never clobbered) ──
let name = $state('');
let password = $state('');
let channel = $state('auto');
let showPassword = $state(false);

let initialized = false;
$effect.pre(() => {
	if (!initialized) {
		name = iface?.hotspot?.name ?? '';
		password = iface?.hotspot?.password ?? '';
		channel = iface?.hotspot?.channel ?? 'auto';
		initialized = true;
	}
});

// ── Channel options: prefer device-reported channels, else common bands ──
const channelOptions = $derived.by(() => {
	const available = iface?.hotspot?.available_channels;
	if (available && Object.keys(available).length > 0) {
		return Object.entries(available).map(([id, c]) => ({ id, name: c.name }));
	}
	return [
		{ id: 'auto', name: $LL.network.modem.automaticRoamingNetwork() },
		{ id: 'auto_50', name: $LL.wifiBands.band_5ghz() },
		{ id: 'auto_24', name: $LL.wifiBands.band_2_4ghz() },
	];
});

const channelLabel = $derived(
	channelOptions.find((c) => c.id === channel)?.name ?? $LL.hotspotConfigurator.hotspot.selectChannel(),
);

// ── Schema-driven validation ──
const nameValid = $derived(name.length >= bounds.name.min && name.length <= bounds.name.max);
const passwordValid = $derived(
	password.length >= bounds.password.min && password.length <= bounds.password.max,
);
const isFormValid = $derived(nameValid && passwordValid);

const nameError = $derived(
	name.length === 0 || nameValid
		? ''
		: name.length < bounds.name.min
			? $LL.hotspotConfigurator.validation.nameMinLength()
			: $LL.hotspotConfigurator.validation.nameMaxLength(),
);
const passwordError = $derived(
	password.length === 0 || passwordValid
		? ''
		: password.length < bounds.password.min
			? $LL.hotspotConfigurator.validation.passwordMinLength()
			: $LL.hotspotConfigurator.validation.passwordMaxLength(),
);

// ── QR for the LIVE active credentials (not the unsaved form) ──
let qrDataUrl = $state('');
$effect(() => {
	const hs = iface?.hotspot;
	if (hs?.name && hs?.password) {
		generateWifiQr(hs.name, hs.password, 'WPA')
			.then((url) => {
				qrDataUrl = url;
			})
			.catch(() => {
				qrDataUrl = '';
			});
	} else {
		qrDataUrl = '';
	}
});

// Save dispatches the reconfigure; `hotspotConfigure` resolves immediately with a
// dispatch ack, so we DON'T confirmOnResolve — the real outcome arrives later as
// a `wifi` event carrying `hotspot.config`, which the subscriptions handler routes
// into `hotspot-config:${deviceId}`. The one-time form sync (`initialized` guard)
// keeps the live QR/iface re-broadcast from clobbering the in-progress edits.
async function handleSave() {
	if (!isFormValid || configuring) return;
	await osCommand({
		key: configKey,
		rpc: () => rpc.wifi.hotspotConfigure({ device: deviceId, name, password, channel }),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
		// NO confirmOnResolve — confirm comes from the deferred hotspot.config event.
	});
}

// Start/stop through the shared keyed op. Stay `pending` after dispatch; the
// confirm $effect below flips to `confirmed` once the snapshot reports the target
// mode (the 15 s TTL valve is the backstop if the device never reports back).
async function handleToggle() {
	if (isActive) {
		toggleTarget = 'station';
		await osCommand({
			key: toggleKey,
			target: 'station',
			rpc: () => rpc.wifi.hotspotStop({ device: deviceId }),
			failMessage: () => $LL.network.os.operationFailed(),
			busyMessage: () => $LL.network.os.deviceBusy(),
		});
	} else {
		toggleTarget = 'hotspot';
		await osCommand({
			key: toggleKey,
			target: 'hotspot',
			rpc: () => rpc.wifi.hotspotStart({ device: deviceId }),
			failMessage: () => $LL.network.os.operationFailed(),
			busyMessage: () => $LL.network.os.deviceBusy(),
		});
	}
}

// Confirm a pending start/stop as soon as the authoritative `wifi` snapshot
// reports the target mode — the QR section then syncs from the live `iface.hotspot`
// naturally (post-confirm).
$effect(() => {
	if (getOperationPhase(toggleKey) !== 'pending') return;
	if (hotspotToggleConfirmed(toggleTarget, isActive)) {
		confirmOperation(toggleKey);
	}
});

// ── Copy SSID / password to clipboard (never logs the secret) ──
async function copyName() {
	if (!name) return;
	try {
		await navigator.clipboard.writeText(name);
		toast.success($LL.network.clipboard.nameCopied());
	} catch {
		toast.error($LL.network.clipboard.copyFailed(), {
			description: $LL.network.clipboard.copyFailedDescription(),
		});
	}
}

async function copyPassword() {
	if (!password) return;
	try {
		await navigator.clipboard.writeText(password);
		toast.success($LL.network.clipboard.passwordCopied());
	} catch {
		toast.error($LL.network.clipboard.copyFailed(), {
			description: $LL.network.clipboard.copyFailedDescription(),
		});
	}
}
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-md"
	description={$LL.hotspotConfigurator.help.description()}
	icon={Router}
	title={$LL.hotspotConfigurator.dialog.configHotspot()}
>
	<div class="space-y-5">
		<!-- Status row -->
		<div
			class={cn(
				'flex items-center gap-3 rounded-lg border px-3 py-2.5',
				isActive ? 'border-status-info/30 bg-status-info/5' : 'bg-muted/40',
			)}
		>
			<span
				class={cn(
					'grid size-8 shrink-0 place-items-center rounded-md',
					isActive ? 'bg-status-info/15 text-status-info' : 'bg-secondary text-muted-foreground',
				)}
			>
				<Wifi class="size-4" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-sm font-medium">
					{isActive ? $LL.network.status.active() : $LL.network.status.inactive()}
				</p>
				{#if iface?.ifname}
					<p class="text-muted-foreground truncate text-xs">{iface.ifname}</p>
				{/if}
			</div>
			<span
				class={cn(
					'size-2 shrink-0 rounded-full',
					isActive ? 'bg-status-info' : 'bg-muted-foreground/40',
				)}
				aria-hidden="true"
			></span>
		</div>

		<!-- Name -->
		<div class="space-y-1.5">
			<Label class="text-sm font-medium" for="hotspot-name">{$LL.network.hotspot.name()}</Label>
			<div class="relative">
				<Input
					id="hotspot-name"
					class="pe-10"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					maxlength={bounds.name.max}
					minlength={bounds.name.min}
					placeholder={$LL.hotspotConfigurator.hotspot.placeholderName()}
					aria-invalid={Boolean(nameError)}
					bind:value={name}
				/>
				<Button
					class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
					aria-label={$LL.network.accessibility.copyName()}
					disabled={!name}
					onclick={copyName}
					size="icon"
					type="button"
					variant="ghost"
				>
					<Copy class="size-4" />
				</Button>
			</div>
			{#if nameError}
				<p class="text-destructive text-xs">{nameError}</p>
			{/if}
		</div>

		<!-- Password -->
		<div class="space-y-1.5">
			<Label class="text-sm font-medium" for="hotspot-password">
				{$LL.network.hotspot.password()}
			</Label>
			<div class="relative">
				<Input
					id="hotspot-password"
					class="pe-20"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					maxlength={bounds.password.max}
					minlength={bounds.password.min}
					placeholder={$LL.hotspotConfigurator.hotspot.placeholderPassword()}
					type={showPassword ? 'text' : 'password'}
					aria-invalid={Boolean(passwordError)}
					bind:value={password}
				/>
				<div class="absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
					<Button
						class="size-8 rounded-md"
						aria-label={$LL.network.accessibility.copyPassword()}
						disabled={!password}
						onclick={copyPassword}
						size="icon"
						type="button"
						variant="ghost"
					>
						<Copy class="size-4" />
					</Button>
					<Button
						class="size-8 rounded-md"
						aria-label={showPassword ? $LL.auth.hidePassword() : $LL.auth.showPassword()}
						onclick={() => (showPassword = !showPassword)}
						size="icon"
						type="button"
						variant="ghost"
					>
						{#if showPassword}
							<EyeOff class="size-4" />
						{:else}
							<Eye class="size-4" />
						{/if}
					</Button>
				</div>
			</div>
			{#if passwordError}
				<p class="text-destructive text-xs">{passwordError}</p>
			{/if}
		</div>

		<!-- Channel -->
		<div class="space-y-1.5">
			<Label class="text-sm font-medium" for="hotspot-channel">
				{$LL.network.hotspot.channel()}
			</Label>
			<Select.Root onValueChange={(v) => (channel = v)} type="single" bind:value={channel}>
				<Select.Trigger id="hotspot-channel" class="w-full">{channelLabel}</Select.Trigger>
				<Select.Content>
					{#each channelOptions as option (option.id)}
						<Select.Item label={option.name} value={option.id} />
					{/each}
				</Select.Content>
			</Select.Root>
			<p class="text-muted-foreground text-xs">{$LL.hotspotConfigurator.help.channelHelp()}</p>
		</div>

		<!-- Live QR for the active hotspot credentials -->
		{#if isActive && qrDataUrl}
			<div class="bg-muted/40 flex flex-col items-center gap-2 rounded-lg border p-4">
				<div class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
					<QrCode class="size-3.5" />
					<span>{$LL.network.accessibility.wifiQrCode()}</span>
				</div>
				<img
					class="size-40 rounded-md bg-white p-2"
					alt={$LL.network.accessibility.wifiQrCode()}
					src={qrDataUrl}
				/>
				{#if iface?.hotspot?.name}
					<p class="text-sm font-medium">{iface.hotspot.name}</p>
				{/if}
			</div>
		{/if}

		<!-- Connect-your-phone: device URL + device-access QR (own RPC source) -->
		<ConnectPhoneSection />
	</div>

	{#snippet actions()}
		<Button class="sm:min-w-24" onclick={() => (open = false)} variant="outline">
			{$LL.network.dialog.close()}
		</Button>
		<Button
			class="sm:min-w-28"
			disabled={toggling || (!isActive && !isFormValid)}
			onclick={handleToggle}
			variant="outline"
		>
			{#if toggling}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{:else}
				<Power class="size-4" />
			{/if}
			{isActive ? $LL.network.status.turnOff() : $LL.network.status.enableHotspot()}
		</Button>
		<Button class="sm:min-w-24" disabled={!isFormValid || configuring} onclick={handleSave}>
			{#if configuring}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{:else}
				<Save class="size-4" />
			{/if}
			{configuring ? $LL.hotspotConfigurator.dialog.saving() : $LL.hotspotConfigurator.dialog.save()}
		</Button>
	{/snippet}
</AppDialog>
