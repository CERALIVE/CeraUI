<!--
  ServerDialog.svelte — receiver/server configuration, surfaced from Live.

  Destination-first orchestration (Task 9). The dialog leads with WHERE the
  stream is sent and only then HOW it gets there:

   1. Streaming-lock banner — config changes need a stop first.
   2. DestinationSection (T6) — managed cloud relay vs. custom receiver, with the
      D6 relay-availability gate baked into the managed choice.
   3. Endpoint config, immediately under the destination pick:
        • managed → RelayServerSelector (provider/server/endpoint/account/streamid,
          plus the per-server transport chooser for multi-transport endpoints).
        • custom  → CustomEndpointForm (kind-driven address/port/streamid/secret +
          the relay.validate action and its multi-stage result).
   4. TransportBadge (T8) — the calm derived "how it reaches the receiver" badge
      with an Advanced disclosure that mounts the transport-protocol radiogroup.
   5. SRT latency slider.

  This stays the logic container: it owns the `draft` dirty-field guard, every
  derived value (destination/protocol/kind via the pure T5
  `receiver-experience` helpers), the relay-validation gate, and the validate +
  save handlers. Live config (`getConfig`) and the relay catalog (`getRelays`)
  are read directly and overlaid only with the operator's edits. The save handler
  delegates the persisted-field selection to `buildServerSetConfig` (T5) and locks
  every field of that SAME object before the RPC (field-lock-before-RPC). Bounds
  and port parsing come from `ValidationAdapter` (RPC schema consts).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Server } from '@lucide/svelte';
import { type RelayProtocol, serverSupportedProtocols } from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Label } from '$lib/components/ui/label';
import {
	isPortValid,
	parsePort,
	streamingConstraints,
} from '$lib/components/streaming/ValidationAdapter';
import {
	type Validation,
	manualSaveEnabled,
	reduceValidateError,
	reduceValidateResult,
} from '$lib/components/streaming/relay-validation';
import { getConfig, getIsStreaming, getRelays } from '$lib/rpc/subscriptions.svelte';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
import {
	type Destination,
	type ServerSetDerived,
	type ServerSetDraft,
	buildServerSetConfig,
	deriveDestination,
	resolveReceiverKind,
} from '$lib/streaming/receiver-experience';
import CustomEndpointForm from './server/CustomEndpointForm.svelte';
import DestinationSection from './server/DestinationSection.svelte';
import RelayServerSelector from './server/RelayServerSelector.svelte';
import TransportBadge from './server/TransportBadge.svelte';

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

type Draft = {
	destination?: Destination;
	relay_protocol?: RelayProtocol;
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

let validation = $state<Validation>({ state: 'idle' });

$effect(() => {
	if (open) {
		draft = {};
		validation = { state: 'idle' };
	}
});

// Destination + transport: the destination defaults to the persisted config
// (a non-empty `relay_server` = managed), the protocol to the persisted protocol
// (legacy configs with none coerce to SRTLA downstream).
const destination = $derived<Destination>(draft.destination ?? deriveDestination(config));
const protocol = $derived<RelayProtocol>(draft.relay_protocol ?? config?.relay_protocol ?? 'srtla');

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

// Transports the selected managed server advertises (T1). A length > 1 reveals
// the per-server transport chooser inside RelayServerSelector.
const relayServerProtocols = $derived(
	relayServerInfo ? serverSupportedProtocols(relayServerInfo) : [],
);

// Receiver kind = transport × destination (T5). For a managed server the
// effective transport is constrained to what that server actually advertises.
const kind = $derived(resolveReceiverKind({ protocol, destination, server: relayServerInfo }));

// Default best = bonded SRTLA: when a multi-transport server is selected whose
// advertised set excludes the current protocol, snap the persisted protocol to
// SRTLA (bonded) when offered, else the first advertised transport. The chooser
// stays the single user-facing writer; this only seeds a valid default.
$effect(() => {
	if (destination !== 'managed' || relayServerProtocols.length <= 1) return;
	if (relayServerProtocols.includes(protocol)) return;
	const best = relayServerProtocols.includes('srtla') ? 'srtla' : relayServerProtocols[0];
	if (best && draft.relay_protocol !== best) draft.relay_protocol = best;
});

const relayOverride = $derived(draft.relay_override ?? false);
const overrideAddr = $derived(draft.relay_override_addr ?? relayServerInfo?.addr ?? '');
const overridePortStr = $derived(
	draft.relay_override_port ?? (relayServerInfo?.port?.toString() ?? ''),
);

const portNum = $derived(parsePort(portStr));
const portError = $derived.by(() => {
	if (destination !== 'custom' || portStr.trim() === '') return undefined;
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
	destination === 'custom' && draft.srtla_addr !== undefined && draft.srtla_addr.trim() === ''
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
	// The reserved plain-SRT kind can never be saved (mirrors the old
	// `!protocolSelectable` reserved-protocol gate).
	if (kind === 'srt_custom') return false;
	if (destination === 'custom') {
		return manualSaveEnabled({
			isStreaming,
			addr,
			portStr,
			hasPortError: portError !== undefined,
			validation,
		});
	}
	if (isStreaming) return false;
	if (relayOverride) {
		return (
			overrideAddr.trim() !== '' &&
			overridePortStr.trim() !== '' &&
			overridePortError === undefined
		);
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
		validation = reduceValidateResult(result);
	} catch (error) {
		validation = reduceValidateError(error);
	}
}

async function handleSave() {
	const draftValues: ServerSetDraft = {
		latency: clampLatency(latency),
		protocol,
		addr,
		portStr,
		streamId,
		overrideAddr,
		overridePortStr,
		relayStreamId,
		relayServer,
		relayAccount,
	};
	const derived: ServerSetDerived = { destination, relayOverride };
	// The SAME object is both locked and persisted: buildServerSetConfig prunes
	// every undefined-valued key, so `Object.entries(input)` is exactly the set
	// of fields setConfig will write.
	const input = buildServerSetConfig(draftValues, derived);
	const fields = Object.entries(input);
	// Lock each field this save changes BEFORE the RPC so a stale server echo of
	// the old value can't revert the edit; release after it settles (resolve or
	// reject) to avoid a permanent lock.
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

		<!-- Destination first (T6): WHERE the stream is sent. The managed choice
		     carries the D6 relay-availability gate (waiting / none hint). -->
		<DestinationSection
			{isStreaming}
			onDestination={(value) => (draft.destination = value)}
			{relays}
			remoteProvider={config?.remote_provider}
			selected={destination}
		/>

		<!-- Endpoint config, immediately under the destination pick. -->
		{#if destination === 'managed'}
			<RelayServerSelector
				{accountEntries}
				{filteredServerEntries}
				{isStreaming}
				managedProviders={MANAGED_PROVIDERS}
				onAccount={(value) => (draft.relay_account = value)}
				onOverrideAddr={(value) => (draft.relay_override_addr = value)}
				onOverridePort={(value) => (draft.relay_override_port = value)}
				onProtocol={(value) => (draft.relay_protocol = value)}
				onProvider={(value) => (draft.relay_provider = value)}
				onRelayStreamId={(value) => (draft.relay_streamid = value)}
				onServer={(value) => (draft.relay_server = value)}
				onToggleOverride={() => (draft.relay_override = !relayOverride)}
				{overrideAddr}
				{overridePortError}
				{overridePortStr}
				port={PORT}
				providerLabels={PROVIDER_LABELS}
				{relayAccount}
				{relayAccountName}
				{relayOverride}
				relayProtocol={protocol}
				{relayServer}
				{relayServerEndpoint}
				{relayServerName}
				{relayServerRtt}
				relaysUnavailable={relays === undefined}
				{relayStreamId}
				serverProtocols={relayServerProtocols}
				{selectedProvider}
			/>
		{:else}
			<CustomEndpointForm
				{addr}
				{addrError}
				{canValidate}
				{isStreaming}
				{kind}
				onAddr={(value) => {
					draft.srtla_addr = value;
					resetValidation();
				}}
				onPassphrase={(value) => {
					draft.passphrase = value;
					resetValidation();
				}}
				onPort={(value) => {
					draft.srtla_port = value;
					resetValidation();
				}}
				onStreamId={(value) => {
					draft.srt_streamid = value;
					resetValidation();
				}}
				onValidate={handleValidate}
				{passphrase}
				port={PORT}
				{portError}
				{portStr}
				{streamId}
				{validation}
			/>
		{/if}

		<!-- Transport badge + Advanced disclosure (T8): the derived "how it
		     reaches the receiver" kind, with the protocol radiogroup behind it. -->
		<TransportBadge
			hasRelayServer={destination === 'managed'}
			{isStreaming}
			onProtocol={(value) => (draft.relay_protocol = value)}
			{protocol}
		/>

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
