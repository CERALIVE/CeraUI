<!--
  ServerDialog.svelte — SRTLA / relay-server configuration, surfaced from Live.

  Method-based UI (Task 16):
   • Two transport methods stay as the existing tab toggle — Manual Configuration
     (a custom relay: address/port/streamid/secret with a "Validate" action) and
     Relay Server (a managed-provider catalog).
   • Relay mode adds a provider selector that groups the catalog by origin, an
     auto-preloaded server endpoint shown READ-ONLY with a "manual override"
     toggle that reveals editable host/port, and an editable Stream ID seeded
     from `relay_streamid_override` (Task 9 auto-fill).
   • Manual mode validates the endpoint through `relay.validate` (Task 8 adapter)
     and surfaces the failing stage inline; Save is blocked while a validation
     is failing or in flight.

  Live config (`getConfig`) and the relay catalog (`getRelays`) are read directly
  and overlaid only with the operator's edits (the `draft` dirty-field guard).
  Validation bounds come from `streamingConstraints` (RPC schema consts).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Server } from '@lucide/svelte';
import type { StreamingConfigInput } from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import RelayRttIndicator from '$lib/components/streaming/RelayRttIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { streamingConstraints } from '$lib/components/streaming/ValidationAdapter';
import { getConfig, getIsStreaming, getRelays } from '$lib/rpc/subscriptions.svelte';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';

interface Props {
	open?: boolean;
}
let { open = $bindable(false) }: Props = $props();

const PORT = streamingConstraints.port;
const LAT = streamingConstraints.srtLatency;
const LATENCY_FALLBACK = Math.min(Math.max(2000, LAT.min), LAT.max);
const LATENCY_STEP = 50;

// Managed cloud providers the relay catalog can be grouped under. Brand names
// are not translated (per the i18n branding convention), so they stay literal.
const MANAGED_PROVIDERS = ['ceralive', 'belabox'] as const;
const PROVIDER_LABELS: Record<string, string> = {
	ceralive: 'CeraLive Cloud',
	belabox: 'BELABOX Cloud',
};

const config = $derived(getConfig());
const relays = $derived(getRelays());
const isStreaming = $derived(Boolean(getIsStreaming()));

type Mode = 'manual' | 'relay';
type Draft = {
	mode?: Mode;
	srtla_addr?: string;
	srtla_port?: string;
	srt_streamid?: string;
	srt_latency?: number;
	relay_provider?: string;
	relay_server?: string;
	relay_account?: string;
	relay_streamid?: string;
	relay_override?: boolean;
	relay_override_addr?: string;
	relay_override_port?: string;
	passphrase?: string;
};
let draft = $state<Draft>({});

type Validation = {
	state: 'idle' | 'validating' | 'pass' | 'fail';
	stage?: string;
	reason?: string;
};
let validation = $state<Validation>({ state: 'idle' });

$effect(() => {
	if (open) {
		draft = {};
		validation = { state: 'idle' };
	}
});

const mode = $derived<Mode>(draft.mode ?? (config?.relay_server ? 'relay' : 'manual'));

const addr = $derived(draft.srtla_addr ?? config?.srtla_addr ?? '');
const portStr = $derived(draft.srtla_port ?? (config?.srtla_port?.toString() ?? ''));
const streamId = $derived(draft.srt_streamid ?? config?.srt_streamid ?? '');
const passphrase = $derived(draft.passphrase ?? '');
const latency = $derived(draft.srt_latency ?? config?.srt_latency ?? LATENCY_FALLBACK);
const relayServer = $derived(draft.relay_server ?? config?.relay_server ?? '');
const relayAccount = $derived(draft.relay_account ?? config?.relay_account ?? '');
const relayStreamId = $derived(draft.relay_streamid ?? config?.relay_streamid_override ?? '');

const serverEntries = $derived(Object.entries(relays?.servers ?? {}));
const accountEntries = $derived(Object.entries(relays?.accounts ?? {}));

// Relay availability gate (D6): the relay tab is always rendered but stays
// disabled with an i18n hint until the catalog exists. `getRelays()` is
// `undefined` until the cloud provider's relays cache is populated (never in
// mock/dev), and may arrive empty — surface the matching waiting / none copy.
const relayUnavailable = $derived(relays === undefined || serverEntries.length === 0);
const relayHint = $derived(
	relays === undefined ? $LL.notifications.relayWaiting() : $LL.notifications.relayNone(),
);

// Provider grouping: untagged catalog servers belong to the device's configured
// provider, so the selector defaults to it and lists only that provider's relays.
const configProvider = $derived(
	config?.remote_provider && config.remote_provider !== 'custom'
		? config.remote_provider
		: 'ceralive',
);
const selectedProvider = $derived(draft.relay_provider ?? configProvider);
const filteredServerEntries = $derived(
	serverEntries.filter(([, info]) => (info.provider?.kind ?? configProvider) === selectedProvider),
);

const relayServerInfo = $derived(relays?.servers?.[relayServer]);
const relayServerName = $derived(relayServerInfo?.name);
const relayServerRtt = $derived(relayServerInfo?.rtt);
const relayServerEndpoint = $derived(
	relayServerInfo?.addr && relayServerInfo?.port
		? `${relayServerInfo.addr}:${relayServerInfo.port}`
		: undefined,
);
const relayAccountName = $derived(relays?.accounts?.[relayAccount]?.name);

const relayOverride = $derived(draft.relay_override ?? false);
const overrideAddr = $derived(draft.relay_override_addr ?? relayServerInfo?.addr ?? '');
const overridePortStr = $derived(
	draft.relay_override_port ?? (relayServerInfo?.port?.toString() ?? ''),
);

function parsePort(value: string): number | undefined {
	return value.trim() === '' ? undefined : Number.parseInt(value, 10);
}
function isPortValid(value: number | undefined): boolean {
	return (
		value !== undefined && Number.isInteger(value) && value >= PORT.min && value <= PORT.max
	);
}

const portNum = $derived(parsePort(portStr));
const portError = $derived.by(() => {
	if (mode !== 'manual' || portStr.trim() === '') return undefined;
	if (!isPortValid(portNum)) return $LL.validation.portRange();
	return undefined;
});
const overridePortNum = $derived(parsePort(overridePortStr));
const overridePortError = $derived.by(() => {
	if (!relayOverride || overridePortStr.trim() === '') return undefined;
	if (!isPortValid(overridePortNum)) return $LL.validation.portRange();
	return undefined;
});
const addrError = $derived(
	mode === 'manual' && draft.srtla_addr !== undefined && draft.srtla_addr.trim() === ''
		? $LL.settings.errors.srtlaServerAddressRequired()
		: undefined,
);

const canValidate = $derived(
	!isStreaming &&
		addr.trim() !== '' &&
		portStr.trim() !== '' &&
		portError === undefined &&
		validation.state !== 'validating',
);

const canSave = $derived.by(() => {
	if (isStreaming) return false;
	if (mode === 'manual') {
		if (validation.state === 'validating' || validation.state === 'fail') return false;
		return addr.trim() !== '' && portStr.trim() !== '' && portError === undefined;
	}
	if (relayOverride) {
		return overrideAddr.trim() !== '' && overridePortStr.trim() !== '' && overridePortError === undefined;
	}
	return relayServer !== '';
});

const latencyPercent = $derived(
	Math.max(0, Math.min(100, ((latency - LAT.min) / (LAT.max - LAT.min)) * 100)),
);

function clampLatency(value: number): number {
	const safe = Number.isFinite(value) ? value : LATENCY_FALLBACK;
	const stepped = Math.round(safe / LATENCY_STEP) * LATENCY_STEP;
	return Math.max(LAT.min, Math.min(LAT.max, stepped));
}

function resetValidation() {
	if (validation.state !== 'idle') validation = { state: 'idle' };
}

async function handleValidate() {
	validation = { state: 'validating' };
	try {
		const result = await rpc.relay.validate({
			addr: addr.trim(),
			port: portNum ?? 0,
			streamid: streamId.trim() === '' ? undefined : streamId.trim(),
			passphrase: passphrase.trim() === '' ? undefined : passphrase.trim(),
			protocol: 'srtla',
		});
		validation = result.ok
			? { state: 'pass', stage: result.stage }
			: { state: 'fail', stage: result.stage, reason: result.reason };
	} catch (error) {
		validation = {
			state: 'fail',
			stage: 'endpoint',
			reason: error instanceof Error ? error.message : undefined,
		};
	}
}

async function handleSave() {
	const input: StreamingConfigInput = {
		srt_latency: clampLatency(latency),
		relay_protocol: 'srtla',
	};
	if (mode === 'manual') {
		input.srtla_addr = addr.trim();
		input.srtla_port = portNum;
		input.srt_streamid = streamId.trim();
	} else if (relayOverride) {
		input.srtla_addr = overrideAddr.trim();
		input.srtla_port = overridePortNum;
		input.relay_streamid_override = relayStreamId.trim();
	} else {
		input.relay_server = relayServer;
		if (relayAccount) input.relay_account = relayAccount;
		input.relay_streamid_override = relayStreamId.trim();
	}
	// Lock each field this save changes BEFORE the RPC so a stale server echo
	// of the old value can't revert the edit; release after it settles (resolve
	// or reject) to avoid a permanent lock.
	const fields = Object.entries(input).filter(([, value]) => value !== undefined);
	for (const [field, value] of fields) markPending(field, value);
	try {
		await rpc.streaming.setConfig(input);
		toast.success($LL.notifications.saved());
		open = false;
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}
</script>

<AppDialog
	bind:open
	icon={Server}
	onPrimary={handleSave}
	primaryDisabled={!canSave}
	primaryLabel={$LL.dialogs.save()}
	title={$LL.settings.receiverServer()}
>
	<div class="space-y-5">
		{#if isStreaming}
			<p
				class="rounded-lg border px-3 py-2 text-sm"
				style="color: var(--status-live); border-color: color-mix(in oklab, var(--status-live) 35%, transparent); background-color: color-mix(in oklab, var(--status-live) 10%, transparent);"
			>
				{$LL.live.stopToChange()}
			</p>
		{/if}

		<!-- Mode toggle: manual SRTLA target vs a managed relay server -->
		<div class="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1" role="tablist">
			<button
				aria-selected={mode === 'manual'}
				class="rounded-md px-3 py-2 text-sm font-medium transition-colors {mode === 'manual'
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'}"
				disabled={isStreaming}
				onclick={() => (draft.mode = 'manual')}
				role="tab"
				type="button"
			>
				{$LL.settings.manualConfiguration()}
			</button>
			<button
				aria-selected={mode === 'relay'}
				class="rounded-md px-3 py-2 text-sm font-medium transition-colors {mode === 'relay'
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'}"
				disabled={relays === undefined || isStreaming}
				onclick={() => (draft.mode = 'relay')}
				role="tab"
				type="button"
			>
				{$LL.settings.relayServer()}
			</button>
		</div>

		<!-- Relay gate hint (D6): explains the disabled relay tab while the relay
		     catalog is missing (waiting) or empty (none). Manual stays usable. -->
		{#if relayUnavailable}
			<p
				class="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-sm"
				role="status"
			>
				{relayHint}
			</p>
		{/if}

		{#if mode === 'manual'}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srtla-addr">
					{$LL.settings.srtlaServerAddress()}
				</Label>
				<Input
					id="srtla-addr"
					aria-invalid={addrError ? 'true' : undefined}
					class="font-mono"
					disabled={isStreaming}
					oninput={(e) => {
						draft.srtla_addr = e.currentTarget.value;
						resetValidation();
					}}
					placeholder={$LL.settings.placeholders.srtlaServerAddress()}
					value={addr}
				/>
				{#if addrError}
					<p class="text-destructive text-sm">{addrError}</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srtla-port">
					{$LL.settings.srtlaServerPort()}
				</Label>
				<Input
					id="srtla-port"
					aria-invalid={portError ? 'true' : undefined}
					class="font-mono"
					disabled={isStreaming}
					inputmode="numeric"
					max={PORT.max}
					min={PORT.min}
					oninput={(e) => {
						draft.srtla_port = e.currentTarget.value;
						resetValidation();
					}}
					placeholder={$LL.settings.placeholders.srtlaServerPort()}
					type="number"
					value={portStr}
				/>
				{#if portError}
					<p class="text-destructive text-sm">{portError}</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srt-streamid">
					{$LL.settings.srtStreamId()}
					<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Input
					id="srt-streamid"
					class="font-mono"
					disabled={isStreaming}
					oninput={(e) => {
						draft.srt_streamid = e.currentTarget.value;
						resetValidation();
					}}
					placeholder={$LL.settings.placeholders.srtStreamId()}
					value={streamId}
				/>
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srtla-passphrase">
					{$LL.settings.relaySecret()}
					<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Input
					id="srtla-passphrase"
					class="font-mono"
					disabled={isStreaming}
					oninput={(e) => {
						draft.passphrase = e.currentTarget.value;
						resetValidation();
					}}
					placeholder={$LL.settings.relaySecretPlaceholder()}
					type="password"
					value={passphrase}
				/>
			</div>

			<!-- Validate the custom relay endpoint via relay.validate (Task 8). -->
			<div class="space-y-2">
				<Button
					id="relay-validate"
					class="w-full"
					disabled={!canValidate}
					onclick={handleValidate}
					variant="outline"
				>
					{validation.state === 'validating' ? $LL.settings.validating() : $LL.settings.validate()}
				</Button>
				{#if validation.state === 'pass'}
					<p class="text-primary text-sm" role="status">
						{$LL.settings.validationPassed()}
					</p>
				{:else if validation.state === 'fail'}
					<p class="text-destructive text-sm" role="alert">
						{$LL.settings.validationFailed()} ({validation.stage}){validation.reason
							? `: ${validation.reason}`
							: ''}
					</p>
				{/if}
			</div>
		{:else}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relay-provider">{$LL.settings.relayProvider()}</Label>
				<Select.Root
					disabled={relays === undefined || isStreaming}
					onValueChange={(value) => (draft.relay_provider = value)}
					type="single"
					value={selectedProvider}
				>
					<Select.Trigger id="relay-provider" class="w-full">
						{PROVIDER_LABELS[selectedProvider] ?? selectedProvider}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each MANAGED_PROVIDERS as providerId (providerId)}
								<Select.Item value={providerId}>{PROVIDER_LABELS[providerId]}</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relay-server">{$LL.settings.relayServer()}</Label>
				<Select.Root
					disabled={relays === undefined || isStreaming}
					onValueChange={(value) => (draft.relay_server = value)}
					type="single"
					value={relayServer}
				>
					<Select.Trigger id="relay-server" class="w-full">
						<span class="flex w-full items-center gap-2">
							<span class="truncate">{relayServerName ?? $LL.settings.relayServer()}</span>
							{#if relayServerName}
								<RelayRttIndicator class="ms-auto" rtt={relayServerRtt} />
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each filteredServerEntries as [id, info] (id)}
								<Select.Item value={id}>
									<div class="flex w-full items-center gap-2">
										<span class="truncate">{info.name}</span>
										<RelayRttIndicator class="ms-auto" rtt={info.rtt} />
									</div>
								</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>

			<!-- Auto-preloaded endpoint: read-only by default, with a manual
			     override toggle revealing editable host/port. -->
			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<Label class="text-sm font-medium" for="relay-endpoint">{$LL.settings.autoEndpoint()}</Label>
					<button
						aria-checked={relayOverride}
						class="text-xs font-medium {relayOverride
							? 'text-primary'
							: 'text-muted-foreground hover:text-foreground'}"
						disabled={isStreaming}
						id="relay-manual-override"
						onclick={() => (draft.relay_override = !relayOverride)}
						role="switch"
						type="button"
					>
						{$LL.settings.manualOverride()}
					</button>
				</div>
				{#if !relayOverride}
					<output
						id="relay-endpoint"
						class="bg-muted/60 text-muted-foreground block rounded-md border px-3 py-2 font-mono text-sm"
					>
						{relayServerEndpoint ?? relayServerName ?? '—'}
					</output>
				{:else}
					<Input
						id="relay-override-addr"
						class="font-mono"
						disabled={isStreaming}
						oninput={(e) => (draft.relay_override_addr = e.currentTarget.value)}
						placeholder={$LL.settings.placeholders.srtlaServerAddress()}
						value={overrideAddr}
					/>
					<Input
						id="relay-override-port"
						aria-invalid={overridePortError ? 'true' : undefined}
						class="font-mono"
						disabled={isStreaming}
						inputmode="numeric"
						max={PORT.max}
						min={PORT.min}
						oninput={(e) => (draft.relay_override_port = e.currentTarget.value)}
						placeholder={$LL.settings.placeholders.srtlaServerPort()}
						type="number"
						value={overridePortStr}
					/>
					{#if overridePortError}
						<p class="text-destructive text-sm">{overridePortError}</p>
					{/if}
				{/if}
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relay-account">
					{$LL.settings.relayServerAccount()}
					<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Select.Root
					disabled={relays === undefined || isStreaming}
					onValueChange={(value) => (draft.relay_account = value)}
					type="single"
					value={relayAccount}
				>
					<Select.Trigger id="relay-account" class="w-full">
						{relayAccountName ?? $LL.settings.manualConfiguration()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each accountEntries as [id, info] (id)}
								<Select.Item value={id}>
									<div class="flex items-center gap-2">
										<div aria-hidden={true} class="bg-primary h-2 w-2 rounded-full"></div>
										{info.name}
									</div>
								</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relay-streamid">
					{$LL.settings.streamId()}
					<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Input
					id="relay-streamid"
					class="font-mono"
					disabled={isStreaming}
					oninput={(e) => (draft.relay_streamid = e.currentTarget.value)}
					placeholder={$LL.settings.placeholders.srtStreamId()}
					value={relayStreamId}
				/>
			</div>
		{/if}

		<!-- SRT latency: bounds come from streamingConstraints.srtLatency -->
		<div class="space-y-3">
			<div class="flex items-center justify-between">
				<Label class="text-sm font-medium" for="srt-latency">{$LL.settings.srtLatency()}</Label>
				<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
					{latency} {$LL.units.ms()}
				</span>
			</div>
			<div class="relative h-6 w-full">
				<div
					class="bg-background absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
				></div>
				<div
					style={`inset-inline-start: 0; width: ${latencyPercent}%;`}
					class="bg-primary absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-150"
				></div>
				<input
					id="srt-latency"
					aria-valuemax={LAT.max}
					aria-valuemin={LAT.min}
					aria-valuenow={latency}
					class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					disabled={isStreaming}
					max={LAT.max}
					min={LAT.min}
					oninput={(e) => (draft.srt_latency = Number.parseInt(e.currentTarget.value, 10))}
					step={LATENCY_STEP}
					type="range"
					value={latency}
				/>
			</div>
			<div class="text-muted-foreground flex justify-between text-xs">
				<span>{LAT.min} {$LL.units.ms()} · {$LL.settings.lowerLatency()}</span>
				<span>{$LL.settings.higherLatency()} · {LAT.max} {$LL.units.ms()}</span>
			</div>
		</div>
	</div>
</AppDialog>
