<!--
  CloudRemoteDialog.svelte — the single "Cloud" dialog (T9).

  Consolidates the two former Streaming-group entries into one surface:

    1. Device pairing (claim code) — CERALIVE ONLY. BeLABOX has no platform
       pairing/claim-code support; Custom has no platform pairing either. The
       section is hidden when a non-CeraLive provider is selected. Generate /
       regenerate a claim code, show the live validity countdown + a QR deep-link
       for phone scanning, and complete pairing. The PRODUCTION `complete-pairing`
       action (`pairing.complete()`) and the DEV-ONLY `simulate-pairing` action
       coexist, gated on `import.meta.env.DEV` — production shows Complete, dev
       shows Simulate. When paired, the subscription-standing badge + bound device
       id are shown. The PairingController state is preserved across a provider
       switch (only reset on dialog close), so switching away from and back to
       CeraLive resumes the still-valid code with its remaining time.

    2. Provider / relay config. Provider select (CeraLive / BELABOX / Custom),
       optional custom host, and the remote key. Saves through the system RPC via
       the saveRemoteConfig helper.

  Managed key gating: when the selected provider IS the active provider AND the
  device is paired to that managed cloud (`isPairedToManagedCloud()`), the remote
  key is READ-ONLY — its endpoints come from the catalog, not manual entry.

  Cross-provider clobber guard: opening/switching to a provider that is NOT the
  active `config.remote_provider` seeds the key EMPTY and requires a freshly
  entered key before Save — the active provider's credential is never carried
  across to a different provider (which would re-persist e.g. a CeraLive device
  token as a BELABOX remote_key).

  Dirty-field guard: each field the operator edits is flagged; live config pushes
  only refresh fields that have NOT been touched, so in-progress edits survive.

  A single PairingController instance owns all pairing state + the countdown
  ticker (there is no second pairing surface).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type {
	CloudProviderEndpoint,
	ProviderSelection,
	SubscriptionStatus,
} from '@ceraui/rpc/schemas';
import {
	BadgeCheck,
	CircleCheck,
	Cloud,
	ExternalLink,
	Eye,
	EyeOff,
	Link2,
	Loader2,
	RefreshCw,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { generateDeviceAccessQr } from '$lib/helpers/NetworkHelper';
import { saveRemoteConfig } from '$lib/helpers/SystemHelper';
import { buildPairingDeepLink } from '$lib/pairing/pairing-link';
import { PairingController } from '$lib/pairing/pairing.svelte';
import {
	shouldAutoRegenerate,
	subscriptionTone,
	type SubscriptionTone,
} from '$lib/pairing/pairing-result';
import { rpc } from '$lib/rpc/client';
import { getConfig } from '$lib/rpc/subscriptions.svelte';
import { isPairedToManagedCloud } from '$lib/stores/pairing.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	/** Preselect this provider on open (deep-link target from ServerDialog). */
	provider?: ProviderSelection;
}

let { open = $bindable(false), provider: requestedProvider }: Props = $props();

// Provider list is sourced from the backend (system.getCloudProviders) — never
// hardcoded. The synthetic `custom` option (appended in providerOptions) carries
// the manual-override escape hatch.
let providers = $state<CloudProviderEndpoint[]>([]);

async function loadProviders() {
	try {
		const result = (await rpc.system.getCloudProviders()) as {
			providers: CloudProviderEndpoint[];
			current: CloudProviderEndpoint;
		};
		providers = result.providers;
	} catch (error) {
		console.error('Failed to load cloud providers:', error);
	}
}

const config = $derived(getConfig());

// Editable form state.
let provider = $state<ProviderSelection>('ceralive');
let remoteKey = $state('');
let customName = $state('');
let customHost = $state('');
let customSecure = $state(true);
let showKey = $state(false);
let saving = $state(false);

// Dirty-field guard.
let dirtyProvider = $state(false);
let dirtyKey = $state(false);
let dirtyCustom = $state(false);
let wasOpen = false;

// Seed the remote key ONLY when the target provider is the active one; a
// different provider must start EMPTY (cross-provider clobber guard).
function seedKeyFor(target: ProviderSelection): string {
	return target === config?.remote_provider ? (config?.remote_key ?? '') : '';
}

$effect(() => {
	// Open edge → seed the form from config and clear dirty flags. A requested
	// provider (deep-link from ServerDialog) wins over config and is marked dirty
	// so the live-config sync below never overwrites the preselect.
	if (open && !wasOpen) {
		void loadProviders();
		provider = requestedProvider ?? config?.remote_provider ?? 'ceralive';
		remoteKey = seedKeyFor(provider);
		customName = config?.custom_provider?.name ?? '';
		customHost = config?.custom_provider?.host ?? '';
		customSecure = config?.custom_provider?.secure ?? true;
		dirtyProvider = requestedProvider !== undefined;
		dirtyKey = false;
		dirtyCustom = false;
	}
	wasOpen = open;
});

$effect(() => {
	// Live config sync for untouched fields only. The key resync respects the
	// clobber guard: never pull the active credential into a different provider.
	if (!open) return;
	const c = config;
	if (!dirtyProvider && c?.remote_provider) provider = c.remote_provider;
	if (!dirtyKey) remoteKey = seedKeyFor(provider);
	if (!dirtyCustom) {
		customName = c?.custom_provider?.name ?? '';
		customHost = c?.custom_provider?.host ?? '';
		customSecure = c?.custom_provider?.secure ?? true;
	}
});

// Backend providers + the synthetic custom-override option. The custom label is
// i18n'd; predefined names come straight from the backend.
const providerOptions = $derived<Array<{ id: ProviderSelection; name: string; cloudUrl?: string }>>([
	...providers.map((p) => ({
		id: p.id as ProviderSelection,
		name: p.name,
		cloudUrl: p.cloudUrl,
	})),
	{ id: 'custom', name: $LL.advanced.customProvider() },
]);

const selected = $derived(providerOptions.find((p) => p.id === provider));
const cloudUrl = $derived(provider === 'custom' ? undefined : selected?.cloudUrl);
// Short provider label for the managed copy (strip a trailing "Cloud" so it does
// not read "…your CeraLive Cloud cloud…").
const providerLabel = $derived(
	selected?.name?.replace(/\s*cloud$/i, '').trim() || selected?.name || provider,
);

// ── Managed-key gating + cross-provider clobber guard ──
// The selected provider is a DIFFERENT managed cloud than the active one only
// when an active provider exists and differs. In that case the key must be
// freshly entered (never carried across).
const isDifferentProvider = $derived(
	config?.remote_provider !== undefined && provider !== config.remote_provider,
);
// Read-only ONLY when the selected provider IS the active provider AND the
// device is paired to that managed cloud (remote_key + managed remote_provider).
const keyManaged = $derived(provider === config?.remote_provider && isPairedToManagedCloud());
// A different provider requires a non-empty newly-entered key before Save.
const keyMissing = $derived(isDifferentProvider && remoteKey.trim() === '');

const customIncomplete = $derived(provider === 'custom' && customHost.trim() === '');
const canSave = $derived(!customIncomplete && !keyMissing && !saving);

// A single PairingController owns pairing state + the countdown ticker. The
// production `complete-pairing` and the dev-only `simulate-pairing` both drive
// `pairing.complete()`; the real cloud dashboard completes the claim in prod.
const pairing = new PairingController();
const isDev = import.meta.env.DEV;

$effect(() => {
	if (open && provider === 'ceralive') {
		pairing.startCountdown();
	} else if (!open) {
		// Dialog close is the ONLY reset: a mere provider switch away preserves the
		// in-flight claim code + countdown so switching back resumes it.
		pairing.stopCountdown();
		pairing.reset();
	} else {
		pairing.stopCountdown();
	}
});

// Regenerate-on-expiry. The pure decision (`shouldAutoRegenerate`) fires only
// for a live `active` code whose window has elapsed; generate() then flips the
// state back to `active` with a fresh window, so this effect cannot loop.
$effect(() => {
	if (provider !== 'ceralive') return;
	if (shouldAutoRegenerate(pairing.status, pairing.expired)) {
		void generateCode();
	}
});

// QR deep-link: encode `/pair?code=…&serial=…` for the cloud portal so an
// operator scans it with a phone and the platform auto-fills the claim form.
// Regenerated whenever the active code/serial changes; cleared otherwise.
let qrDataUrl = $state<string | null>(null);

$effect(() => {
	if (provider !== 'ceralive') {
		qrDataUrl = null;
		return;
	}
	const code = pairing.code;
	const serial = pairing.serial;
	if (!code || !serial) {
		qrDataUrl = null;
		return;
	}
	let cancelled = false;
	void generateDeviceAccessQr(buildPairingDeepLink({ code, serial }))
		.then((url) => {
			if (!cancelled) qrDataUrl = url;
		})
		.catch(() => {
			if (!cancelled) qrDataUrl = null;
		});
	return () => {
		cancelled = true;
	};
});

async function generateCode() {
	try {
		await pairing.generate();
	} catch {
		toast.error($LL.settings.pairing.generateFailed());
	}
}

// Production completion (`complete-pairing`) AND dev simulation (`simulate-pairing`)
// both resolve through the same controller call — they differ only in gating +
// affordance, not behaviour.
async function completePairing() {
	try {
		const result = await pairing.complete();
		if (result?.paired) {
			toast.success($LL.settings.pairing.pairedToast());
		} else if (result) {
			toast.error($LL.settings.pairing.pairFailed());
		}
	} catch {
		toast.error($LL.settings.pairing.pairFailed());
	}
}

// Subscription standing → semantic badge classes (tone from the pure reducer).
const TONE_CLASS: Record<SubscriptionTone, string> = {
	positive: 'bg-primary/10 text-primary',
	neutral: 'bg-secondary text-muted-foreground',
	warning: 'bg-status-warning/10 text-status-warning',
	critical: 'bg-destructive/10 text-destructive',
};

function subscriptionLabel(status: SubscriptionStatus): string {
	switch (status) {
		case 'ACTIVE':
			return $LL.settings.pairing.statusActive();
		case 'FREE':
			return $LL.settings.pairing.statusFree();
		case 'EXPIRED':
			return $LL.settings.pairing.statusExpired();
		case 'CANCELLED':
			return $LL.settings.pairing.statusCancelled();
	}
}

const subStatus = $derived(pairing.subStatus);

async function save() {
	if (!canSave) return;
	saving = true;
	try {
		await saveRemoteConfig({
			remote_key: remoteKey,
			provider,
			custom_provider:
				provider === 'custom'
					? {
							name: customName || 'Custom',
							host: customHost,
							path: '/ws/remote',
							secure: customSecure,
						}
					: undefined,
		});
		toast.success($LL.advanced.remoteConfigSaved());
		dirtyProvider = false;
		dirtyKey = false;
		dirtyCustom = false;
		open = false;
	} catch (error) {
		console.error('Failed to save remote config:', error);
		toast.error($LL.advanced.copyFailed());
	} finally {
		saving = false;
	}
}
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.cloudRemoteDesc()}
	icon={Cloud}
	onPrimary={save}
	primaryDisabled={!canSave}
	primaryLabel={$LL.advanced.save()}
	closeOnPrimary={false}
	title={$LL.settings.index.cloudRemote()}
>
	<div class="space-y-5">
		<!-- Device pairing (claim code) — CeraLive only; no BeLABOX/Custom platform pairing. -->
		{#if provider === 'ceralive'}
		<section class="bg-muted/40 space-y-3 rounded-lg border p-4" data-testid="device-pairing">
			<div class="flex items-start gap-3">
				<span
					class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg"
				>
					<Link2 class="size-[18px]" />
				</span>
				<div class="min-w-0 flex-1 space-y-0.5">
					<h3 class="text-sm font-semibold">{$LL.settings.pairing.title()}</h3>
					<p class="text-muted-foreground text-xs">{$LL.settings.pairing.description()}</p>
				</div>
			</div>

			{#if pairing.status === 'paired'}
				<!-- Paired: confirmation + subscription standing + bound device id. -->
				<div class="space-y-4 text-center">
					<span
						class="bg-primary/10 text-primary mx-auto grid size-12 place-items-center rounded-full"
					>
						<BadgeCheck class="size-6" />
					</span>
					<div class="space-y-1">
						<p class="text-sm font-semibold" data-testid="pairing-status">
							{$LL.settings.pairing.paired()}
						</p>
						<p class="text-muted-foreground mx-auto max-w-sm text-xs">
							{$LL.settings.pairing.pairedBody()}
						</p>
					</div>

					<dl class="divide-border bg-background/60 divide-y overflow-hidden rounded-lg border text-start">
						{#if subStatus}
							<div class="flex items-center justify-between gap-4 px-4 py-3">
								<dt class="text-muted-foreground text-sm">{$LL.settings.pairing.subscriptionLabel()}</dt>
								<dd>
									<span
										class={cn(
											'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold',
											TONE_CLASS[subscriptionTone(subStatus)],
										)}
										data-testid="pairing-sub-status"
									>
										<CircleCheck class="size-3.5" />
										{subscriptionLabel(subStatus)}
									</span>
								</dd>
							</div>
						{/if}
						{#if pairing.deviceId}
							<div class="flex items-center justify-between gap-4 px-4 py-3">
								<dt class="text-muted-foreground text-sm">{$LL.settings.pairing.deviceLabel()}</dt>
								<dd class="font-mono text-sm font-medium" data-testid="pairing-device-id">
									{pairing.deviceId}
								</dd>
							</div>
						{/if}
					</dl>
				</div>
			{:else if pairing.status === 'error'}
				<!-- Error precedes the active-code branch: a rejected complete leaves
				     status='error' while pairing.code is still set, so this must be
				     matched first or the code branch shadows it. -->
				<div class="space-y-3">
					<p class="text-destructive text-sm" data-testid="pairing-error">
						{$LL.settings.pairing.pairFailed()}
					</p>
					<Button onclick={generateCode} size="sm" data-testid="generate-claim-code">
						<RefreshCw class="size-4" />
						{$LL.settings.pairing.regenerate()}
					</Button>
				</div>
			{:else if pairing.code}
				<!-- Active code: display, live countdown, QR, complete + regenerate. -->
				<div class="space-y-2">
					<p class="text-muted-foreground text-xs">{$LL.settings.pairing.codeLabel()}</p>
					<div
						class="bg-background rounded-md border px-4 py-3 text-center font-mono text-2xl font-bold tracking-[0.3em]"
						data-testid="claim-code"
					>
						{pairing.code}
					</div>
					{#if pairing.expired}
						<p
							class="text-status-warning flex items-center gap-1.5 text-xs"
							data-testid="claim-code-expiry"
						>
							<Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" />
							{$LL.settings.pairing.regenerating()}
						</p>
					{:else}
						<p class="text-muted-foreground text-xs" data-testid="claim-code-expiry">
							{$LL.settings.pairing.validFor()}
							<span class="text-foreground font-mono font-medium">{pairing.remainingLabel}</span>
						</p>
					{/if}
					<p class="text-muted-foreground text-xs">{$LL.settings.pairing.instructions()}</p>

					{#if qrDataUrl}
						<div class="flex flex-col items-center gap-2 pt-1" data-testid="pairing-qr">
							<img
								src={qrDataUrl}
								alt={$LL.settings.pairing.scanToPair()}
								class="bg-background size-40 rounded-md border p-2"
								width="160"
								height="160"
							/>
							<p class="text-muted-foreground max-w-xs text-center text-xs">
								{$LL.settings.pairing.scanToPair()}
							</p>
						</div>
					{/if}
				</div>

				<div class="flex flex-wrap gap-2">
					{#if !isDev}
						<Button
							disabled={pairing.status === 'pairing' || pairing.expired}
							onclick={completePairing}
							size="sm"
							data-testid="complete-pairing"
						>
							{#if pairing.status === 'pairing'}
								<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
								{$LL.settings.pairing.waiting()}
							{:else}
								{$LL.settings.pairing.complete()}
							{/if}
						</Button>
					{/if}
					<Button
						disabled={pairing.status === 'generating'}
						onclick={generateCode}
						size="sm"
						variant="outline"
						data-testid="regenerate-claim-code"
					>
						<RefreshCw class="size-4" />
						{$LL.settings.pairing.regenerate()}
					</Button>
					{#if isDev}
						<Button
							disabled={pairing.status === 'pairing' || pairing.expired}
							onclick={completePairing}
							size="sm"
							data-testid="simulate-pairing"
						>
							{#if pairing.status === 'pairing'}
								<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
							{/if}
							{$LL.settings.pairing.simulate()}
						</Button>
					{/if}
				</div>
			{:else}
				<!-- Idle: a single call to action to mint the first code. -->
				<Button
					disabled={pairing.status === 'generating'}
					onclick={generateCode}
					size="sm"
					data-testid="generate-claim-code"
				>
					{#if pairing.status === 'generating'}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{/if}
					{$LL.settings.pairing.generate()}
				</Button>
			{/if}
		</section>
		{/if}

		<!-- Provider select -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="cloud-provider">{$LL.advanced.cloudProvider()}</Label>
			<Select.Root
				type="single"
				value={provider}
				onValueChange={(v) => {
					const next = v as ProviderSelection;
					provider = next;
					dirtyProvider = true;
					// Clobber guard: switching to a different provider must not carry
					// the active credential across — reseed the key for the target.
					remoteKey = seedKeyFor(next);
					dirtyKey = false;
				}}
			>
				<Select.Trigger id="cloud-provider" class="w-full">
					{selected?.name ?? $LL.advanced.cloudProvider()}
				</Select.Trigger>
				<Select.Content>
					{#each providerOptions as p (p.id)}
						<Select.Item value={p.id}>{p.name}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<!-- Custom provider fields -->
		{#if provider === 'custom'}
			<div class="bg-muted/40 space-y-4 rounded-lg border p-4">
				<div class="space-y-2">
					<Label class="text-sm font-medium" for="custom-name">{$LL.advanced.providerName()}</Label>
					<Input
						id="custom-name"
						placeholder={$LL.advanced.providerNamePlaceholder()}
						value={customName}
						oninput={(e) => {
							customName = e.currentTarget.value;
							dirtyCustom = true;
						}}
					/>
				</div>
				<div class="space-y-2">
					<Label class="text-sm font-medium" for="custom-host">{$LL.advanced.providerHost()}</Label>
					<Input
						id="custom-host"
						placeholder={$LL.advanced.providerHostPlaceholder()}
						value={customHost}
						oninput={(e) => {
							customHost = e.currentTarget.value;
							dirtyCustom = true;
						}}
					/>
					<p class="text-muted-foreground text-xs">{$LL.advanced.providerHostHint()}</p>
				</div>
				<div class="flex items-center justify-between gap-4">
					<Label class="text-sm" for="custom-secure">{$LL.advanced.useSecureConnection()}</Label>
					<LabeledSwitch
						checked={customSecure}
						label={$LL.advanced.useSecureConnection()}
						onCheckedChange={(v) => {
							customSecure = v;
							dirtyCustom = true;
						}}
					/>
				</div>
			</div>
		{/if}

		<!-- Cloud dashboard link -->
		{#if cloudUrl}
			<a
				class="text-primary hover:text-primary/80 inline-flex items-center gap-1.5 text-sm font-medium transition-colors hover:underline"
				href={cloudUrl}
				rel="noopener noreferrer"
				target="_blank"
			>
				{$LL.settings.dialogs.getYourKey()}
				<ExternalLink class="size-3.5" />
			</a>
		{/if}

		<!-- Remote key -->
		{#if keyManaged}
			<!-- Active managed cloud: the key is catalog-managed, not manually entered. -->
			<div class="space-y-2" data-testid="remote-key-managed">
				<Label class="text-sm font-medium">{$LL.advanced.cloudRemoteKey()}</Label>
				<p class="text-muted-foreground text-xs">
					{$LL.advanced.remoteKeyManagedByCloud({ provider: providerLabel })}
				</p>
				<div
					class="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 font-mono text-sm tracking-widest select-none"
					aria-readonly="true"
				>
					{'•'.repeat(16)}
				</div>
			</div>
		{:else}
			<div class="space-y-2" data-testid="remote-key">
				<Label class="text-sm font-medium" for="remote-key">{$LL.advanced.cloudRemoteKey()}</Label>
				<p class="text-muted-foreground text-xs">{$LL.advanced.cloudRemoteKeyTooltip()}</p>
				<div class="relative">
					<Input
						id="remote-key"
						autocomplete="off"
						class="pe-11"
						spellcheck={false}
						type={showKey ? 'text' : 'password'}
						value={remoteKey}
						oninput={(e) => {
							remoteKey = e.currentTarget.value;
							dirtyKey = true;
						}}
					/>
					<Button
						aria-label={showKey ? $LL.advanced.hideRemoteKey() : $LL.advanced.showRemoteKey()}
						class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
						onclick={() => (showKey = !showKey)}
						size="icon"
						type="button"
						variant="ghost"
					>
						{#if showKey}
							<EyeOff class="size-4" />
						{:else}
							<Eye class="size-4" />
						{/if}
					</Button>
				</div>
			</div>
		{/if}
	</div>
</AppDialog>
