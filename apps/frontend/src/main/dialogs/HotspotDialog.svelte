<!--
  HotspotDialog.svelte — configure / start / stop the device WiFi hotspot.

  Composes the shared AppDialog chrome (responsive Dialog ⇆ Sheet). Hotspot and
  the WiFi station are independent: this dialog never disables WiFi, it only
  drives the hotspot RPCs (configure / start / stop) for one WiFi interface.

  • Name / password / channel form, schema-driven bounds from ValidationAdapter
    (HOTSPOT_NAME_MIN/MAX, HOTSPOT_PASSWORD_MIN/MAX) — single source of truth.
  • Security is offered from the DEVICE's own `available_security` map and never
    from a local table; the read-only radio line states the width/generation the
    same capability read produced. Both derive in `hotspot-options.ts`, and both
    render NOTHING when the device did not report them — which is what keeps an
    older backend showing exactly the name/password/channel set it always did.
    There is deliberately no width SELECTOR: NetworkManager 1.42 publishes no
    hotspot channel-width property, so the control could not act.
  • Save  → rpc.wifi.hotspotConfigure, Start → rpc.wifi.hotspotStart,
    Stop → rpc.wifi.hotspotStop — all dispatched through `osCommand` (the single
    OS-op feedback path: keyed spinner, DEVICE_BUSY + failure toasts).
  • When the hotspot is active, ONE QR encoding the live credentials is rendered
    so phones can join by scan. Its `T:` token follows the LIVE security mode
    (`hotspotQrSecurity`): a WPA3-SAE AP advertised as `T:WPA` yields a code that
    scans perfectly and then refuses to join.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { HotspotSecurityId, WifiInterface } from '@ceraui/rpc/schemas';
import {
	Copy,
	Eye,
	EyeOff,
	Loader2,
	Power,
	QrCode,
	Radio,
	Router,
	Save,
	ShieldCheck,
	Wifi,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { networkConstraints } from '$lib/components/streaming';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { generateWifiQr, hotspotQrSecurity } from '$lib/helpers/NetworkHelper';
import {
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { hotspotIsActive, hotspotToggleConfirmed } from '$lib/rpc/os-toggle-predicates';
import { cn } from '$lib/utils';

import {
	deriveHotspotRadioTruth,
	deriveHotspotSecurityChoice,
	type HotspotSecurityOption,
} from './hotspot-options';

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
// `undefined` until the one-time sync runs AND the device offers a real choice;
// a save then omits `security` entirely, which the device reads as "leave the
// adapter's current selection alone".
let security = $state<HotspotSecurityId | undefined>(undefined);

// ── Capability-derived options (device truth only — see hotspot-options.ts) ──
const securityChoice = $derived(deriveHotspotSecurityChoice(iface?.hotspot));
const radioTruth = $derived(deriveHotspotRadioTruth(iface?.hotspot, iface?.capabilities));

let initialized = false;
$effect.pre(() => {
	if (!initialized) {
		name = iface?.hotspot?.name ?? '';
		password = iface?.hotspot?.password ?? '';
		channel = iface?.hotspot?.channel ?? 'auto';
		// Seeded from the DEVICE's resolved selection, so the control never opens
		// on a mode the device would refuse.
		const choice = deriveHotspotSecurityChoice(iface?.hotspot);
		security = choice?.kind === 'select' ? choice.selected : undefined;
		initialized = true;
	}
});

const securityLabel = $derived(
	securityChoice?.kind === 'select'
		? (securityChoice.options.find((o: HotspotSecurityOption) => o.id === security)?.name ??
				m["hotspotConfigurator.hotspot.selectSecurity"]())
		: '',
);

// ── Channel options: prefer device-reported channels, else common bands ──
const channelOptions = $derived.by(() => {
	const available = iface?.hotspot?.available_channels;
	if (available && Object.keys(available).length > 0) {
		return Object.entries(available).map(([id, c]) => ({ id, name: c.name }));
	}
	return [
		{ id: 'auto', name: m["network.modem.automaticRoamingNetwork"]() },
		{ id: 'auto_50', name: m["wifiBands.band_5ghz"]() },
		{ id: 'auto_24', name: m["wifiBands.band_2_4ghz"]() },
	];
});

const channelLabel = $derived(
	channelOptions.find((c) => c.id === channel)?.name ?? m["hotspotConfigurator.hotspot.selectChannel"](),
);

// ── Schema-driven validation ──
const nameValid = $derived(name.length >= bounds.name.min && name.length <= bounds.name.max);
const passwordValid = $derived(
	password.length >= bounds.password.min && password.length <= bounds.password.max,
);
const isFormValid = $derived(nameValid && passwordValid);

// Reason surfaced on the start/stop control while it is disabled, so the operator
// is never left guessing (busy op vs an incomplete form).
const toggleDisabledReason = $derived(
	toggling
		? m["hotspotConfigurator.toggleReason.busy"]()
		: !isActive && !isFormValid
			? m["hotspotConfigurator.toggleReason.formInvalid"]()
			: undefined,
);

const nameError = $derived(
	name.length === 0 || nameValid
		? ''
		: name.length < bounds.name.min
			? m["hotspotConfigurator.validation.nameMinLength"]()
			: m["hotspotConfigurator.validation.nameMaxLength"](),
);
const passwordError = $derived(
	password.length === 0 || passwordValid
		? ''
		: password.length < bounds.password.min
			? m["hotspotConfigurator.validation.passwordMinLength"]()
			: m["hotspotConfigurator.validation.passwordMaxLength"](),
);

// ── QR for the LIVE active credentials (not the unsaved form) ──
let qrDataUrl = $state('');
$effect(() => {
	const hs = iface?.hotspot;
	if (hs?.name && hs?.password) {
		// The LIVE mode, not the draft: this QR carries the credentials the AP is
		// broadcasting right now, so its auth token must describe that AP too.
		generateWifiQr(hs.name, hs.password, hotspotQrSecurity(hs.security))
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
		rpc: () =>
			rpc.wifi.hotspotConfigure({
				device: deviceId,
				name,
				password,
				channel,
				// Omitted unless the device offered a real choice, so a save on an
				// adapter with one mode cannot re-state a selection it never made.
				...(security !== undefined ? { security } : {}),
			}),
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
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
			failMessage: () => m["network.os.operationFailed"](),
			busyMessage: () => m["network.os.deviceBusy"](),
		});
	} else {
		toggleTarget = 'hotspot';
		await osCommand({
			key: toggleKey,
			target: 'hotspot',
			rpc: () => rpc.wifi.hotspotStart({ device: deviceId }),
			failMessage: () => m["network.os.operationFailed"](),
			busyMessage: () => m["network.os.deviceBusy"](),
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
	if (await copyToClipboard(name)) {
		toast.success(m["network.clipboard.nameCopied"]());
	} else {
		toast.error(m["network.clipboard.copyFailed"](), {
			description: m["network.clipboard.copyFailedDescription"](),
		});
	}
}

async function copyPassword() {
	if (!password) return;
	if (await copyToClipboard(password)) {
		toast.success(m["network.clipboard.passwordCopied"]());
	} else {
		toast.error(m["network.clipboard.copyFailed"](), {
			description: m["network.clipboard.copyFailedDescription"](),
		});
	}
}
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-md"
	description={m["hotspotConfigurator.help.description"]()}
	icon={Router}
	title={m["hotspotConfigurator.dialog.configHotspot"]()}
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
					{isActive ? m["network.status.active"]() : m["network.status.inactive"]()}
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
			<Label class="text-sm font-medium" for="hotspot-name">{m["network.hotspot.name"]()}</Label>
			<div class="relative">
				<Input
					id="hotspot-name"
					class="pe-10"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					maxlength={bounds.name.max}
					minlength={bounds.name.min}
					placeholder={m["hotspotConfigurator.hotspot.placeholderName"]()}
					aria-invalid={Boolean(nameError)}
					bind:value={name}
				/>
				<Button
					class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
					aria-label={m["network.accessibility.copyName"]()}
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
				{m["network.hotspot.password"]()}
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
					placeholder={m["hotspotConfigurator.hotspot.placeholderPassword"]()}
					type={showPassword ? 'text' : 'password'}
					aria-invalid={Boolean(passwordError)}
					bind:value={password}
				/>
				<div class="absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
					<Button
						class="size-8 rounded-md"
						aria-label={m["network.accessibility.copyPassword"]()}
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
						aria-label={showPassword ? m["auth.hidePassword"]() : m["auth.showPassword"]()}
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
				{m["network.hotspot.channel"]()}
			</Label>
			<Select.Root onValueChange={(v) => (channel = v)} type="single" bind:value={channel}>
				<Select.Trigger id="hotspot-channel" class="w-full">{channelLabel}</Select.Trigger>
				<Select.Content>
					{#each channelOptions as option (option.id)}
						<Select.Item label={option.name} value={option.id} />
					{/each}
				</Select.Content>
			</Select.Root>
			<p class="text-muted-foreground text-xs">{m["hotspotConfigurator.help.channelHelp"]()}</p>
		</div>

		<!--
			Security. Rendered ONLY from the device's own offered map:
			 · two or more modes → a real selector
			 · exactly one       → stated, because one option is not a choice
			 · none reported     → nothing at all (older backend / no derivation)
		-->
		{#if securityChoice?.kind === 'select'}
			<div class="space-y-1.5" data-testid="hotspot-security-select">
				<Label class="text-sm font-medium" for="hotspot-security">
					{m["hotspotConfigurator.hotspot.security"]()}
				</Label>
				<Select.Root
					onValueChange={(v) => {
						// Narrowed rather than cast: the wire enum is the acceptance set,
						// so a value outside it is refused instead of persisted.
						if (v === 'wpa2' || v === 'wpa3-sae') security = v;
					}}
					type="single"
					value={security ?? ''}
				>
					<Select.Trigger id="hotspot-security" class="w-full">{securityLabel}</Select.Trigger>
					<Select.Content>
						{#each securityChoice.options as option (option.id)}
							<Select.Item
								data-testid="hotspot-security-option-{option.id}"
								label={option.name}
								value={option.id}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
				<p class="text-muted-foreground text-xs">
					{m["hotspotConfigurator.help.securityHelp"]()}
				</p>
			</div>
		{:else if securityChoice?.kind === 'stated'}
			<div
				class="text-muted-foreground flex items-center gap-2 text-xs"
				data-testid="hotspot-security-stated"
			>
				<ShieldCheck aria-hidden="true" class="size-3.5 shrink-0" />
				<span>{m["hotspotConfigurator.hotspot.security"]()}</span>
				<span class="text-foreground font-medium">{securityChoice.option.name}</span>
			</div>
		{/if}

		<!--
			READ-ONLY radio truth. Width has no selector anywhere in this contract —
			NetworkManager 1.42 exposes no hotspot channel-width property, so one
			could not act. Demoted per DESIGN.md §2 (hardware tags, muted, never the
			phosphor-lime accent, which stays reserved for the live signal).
		-->
		{#if radioTruth}
			<div
				class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
				data-testid="hotspot-radio-truth"
			>
				<Radio aria-hidden="true" class="size-3.5 shrink-0" />
				{#if radioTruth.generationLabelKey}
					<span data-testid="hotspot-radio-generation">
						{resolveMessageKey(radioTruth.generationLabelKey)}
					</span>
				{/if}
				{#each radioTruth.bands as band (band.band)}
					<span data-testid="hotspot-radio-width-{band.band}">
						{resolveMessageKey(band.labelKey)}
						·
						{m["network.wifiCapability.width"]({ mhz: band.widthMhz })}
					</span>
				{/each}
			</div>
		{/if}

		<!-- Live QR for the active hotspot credentials -->
		{#if isActive && qrDataUrl}
			<div class="bg-muted/40 flex flex-col items-center gap-2 rounded-lg border p-4">
				<div class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
					<QrCode class="size-3.5" />
					<span>{m["network.accessibility.wifiQrCode"]()}</span>
				</div>
				<img
					class="size-40 rounded-md bg-white p-2"
					alt={m["network.accessibility.wifiQrCode"]()}
					src={qrDataUrl}
				/>
				{#if iface?.hotspot?.name}
					<p class="text-sm font-medium">{iface.hotspot.name}</p>
				{/if}
			</div>
		{/if}
	</div>

	{#snippet actions()}
		<Button class="sm:min-w-24" onclick={() => (open = false)} variant="outline">
			{m["network.dialog.close"]()}
		</Button>
		<Button
			class="sm:min-w-28"
			disabled={toggling || (!isActive && !isFormValid)}
			onclick={handleToggle}
			title={toggleDisabledReason}
			variant="outline"
		>
			{#if toggling}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{:else}
				<Power class="size-4" />
			{/if}
			{isActive ? m["network.status.turnOff"]() : m["network.status.enableHotspot"]()}
		</Button>
		<Button class="sm:min-w-24" disabled={!isFormValid || configuring} onclick={handleSave}>
			{#if configuring}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{:else}
				<Save class="size-4" />
			{/if}
			{configuring ? m["hotspotConfigurator.dialog.saving"]() : m["hotspotConfigurator.dialog.save"]()}
		</Button>
	{/snippet}
</AppDialog>
