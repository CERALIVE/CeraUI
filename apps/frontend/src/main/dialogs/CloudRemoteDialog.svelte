<!--
  CloudRemoteDialog.svelte — cloud relay / remote-management configuration (Task 25).

  Provider select (CeraLive / BELABOX / Custom). For a custom provider the name,
  host and secure (wss) fields are revealed. A remote key (masked, show/hide) and
  a link to the provider's cloud dashboard round it out. Saves through the system
  RPC via the saveRemoteConfig helper.

  Dirty-field guard: each field the operator edits is flagged; live config pushes
  only refresh fields that have NOT been touched, so in-progress edits survive.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CloudProviderEndpoint, ProviderSelection } from '@ceraui/rpc/schemas';
import { Check, Cloud, ExternalLink, Eye, EyeOff, Link2, Loader2, RefreshCw } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { saveRemoteConfig } from '$lib/helpers/SystemHelper';
import { PairingController } from '$lib/pairing/pairing.svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig } from '$lib/rpc/subscriptions.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

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

$effect(() => {
	// Open edge → seed the form from config and clear dirty flags.
	if (open && !wasOpen) {
		void loadProviders();
		provider = config?.remote_provider ?? 'ceralive';
		remoteKey = config?.remote_key ?? '';
		customName = config?.custom_provider?.name ?? '';
		customHost = config?.custom_provider?.host ?? '';
		customSecure = config?.custom_provider?.secure ?? true;
		dirtyProvider = false;
		dirtyKey = false;
		dirtyCustom = false;
	}
	wasOpen = open;
});

$effect(() => {
	// Live config sync for untouched fields only.
	if (!open) return;
	const c = config;
	if (!dirtyProvider && c?.remote_provider) provider = c.remote_provider;
	if (!dirtyKey) remoteKey = c?.remote_key ?? '';
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
const customIncomplete = $derived(provider === 'custom' && customHost.trim() === '');
const canSave = $derived(!customIncomplete && !saving);

// Claim-code pairing. The mock-platform "simulate" affordance is dev-only; in
// production the real cloud dashboard completes the claim and the device polls.
const pairing = new PairingController();
const isDev = import.meta.env.DEV;

$effect(() => {
	if (open) {
		pairing.startCountdown();
	} else {
		pairing.stopCountdown();
		pairing.reset();
	}
});

async function generateCode() {
	try {
		await pairing.generate();
	} catch {
		toast.error($LL.settings.pairing.generateFailed());
	}
}

async function simulatePairing() {
	try {
		const result = await pairing.complete();
		if (result?.paired) {
			toast.success($LL.settings.pairing.pairedToast());
		} else {
			toast.error($LL.settings.pairing.pairFailed());
		}
	} catch {
		toast.error($LL.settings.pairing.pairFailed());
	}
}

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
		<!-- Device pairing (claim code) -->
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
				<div
					class="text-primary flex items-center gap-2 text-sm font-medium"
					data-testid="pairing-status"
				>
					<Check class="size-4" />
					{$LL.settings.pairing.paired()}
				</div>
			{:else if pairing.code}
				<div class="space-y-2">
					<p class="text-muted-foreground text-xs">{$LL.settings.pairing.codeLabel()}</p>
					<div
						class="bg-background rounded-md border px-4 py-3 text-center font-mono text-2xl font-bold tracking-[0.3em]"
						data-testid="claim-code"
					>
						{pairing.code}
					</div>
					{#if pairing.expired}
						<p class="text-destructive text-xs" data-testid="claim-code-expiry">
							{$LL.settings.pairing.expired()}
						</p>
					{:else}
						<p class="text-muted-foreground text-xs" data-testid="claim-code-expiry">
							{$LL.settings.pairing.validFor()}
							<span class="font-mono">{pairing.remainingLabel}</span>
						</p>
					{/if}
					<p class="text-muted-foreground text-xs">{$LL.settings.pairing.instructions()}</p>
				</div>

				<div class="flex flex-wrap gap-2">
					<Button
						disabled={pairing.status === 'generating'}
						onclick={generateCode}
						size="sm"
						variant="outline"
					>
						<RefreshCw class="size-4" />
						{$LL.settings.pairing.regenerate()}
					</Button>
					{#if isDev}
						<Button
							disabled={pairing.status === 'pairing' || pairing.expired}
							onclick={simulatePairing}
							size="sm"
							data-testid="simulate-pairing"
						>
							{#if pairing.status === 'pairing'}
								<Loader2 class="size-4 animate-spin" />
							{/if}
							{$LL.settings.pairing.simulate()}
						</Button>
					{/if}
				</div>
			{:else}
				<Button
					disabled={pairing.status === 'generating'}
					onclick={generateCode}
					size="sm"
					data-testid="generate-claim-code"
				>
					{#if pairing.status === 'generating'}
						<Loader2 class="size-4 animate-spin" />
					{/if}
					{$LL.settings.pairing.generate()}
				</Button>
			{/if}
		</section>

		<!-- Provider select -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="cloud-provider">{$LL.advanced.cloudProvider()}</Label>
			<Select.Root
				type="single"
				value={provider}
				onValueChange={(v) => {
					provider = v as ProviderSelection;
					dirtyProvider = true;
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
						placeholder="My Custom Cloud"
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
						placeholder="remote.example.com"
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
		<div class="space-y-2">
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
	</div>
</AppDialog>
