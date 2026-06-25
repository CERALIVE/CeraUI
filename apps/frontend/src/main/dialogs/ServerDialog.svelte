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
import { Server, TriangleAlert } from '@lucide/svelte';
import {
	CLOUD_PROVIDERS,
	type RelayProtocol,
	serverSupportedProtocols,
} from '@ceraui/rpc/schemas';
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
import {
	getCapabilities,
	getConfig,
	getIsStreaming,
	getManagedIngestAccounts,
	getRelays,
	getSelectedIngestEndpoint,
} from '$lib/rpc/subscriptions.svelte';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
import { isPairedToManagedCloud } from '$lib/stores/pairing.svelte';
import {
	type Destination,
	type ServerSetDerived,
	type ServerSetDraft,
	autoSelectIngestSlot,
	autoSelectManagedRelay,
	autoSelectManagedTransport,
	availableManagedProviders,
	buildManagedSlotConfig,
	buildServerSetConfig,
	deriveDestination,
	deriveReceiverCaps,
	deriveReceiverProfileKind,
	deriveStreamTuningExperience,
	isRelayServerStaleForProvider,
	overrideClearsManagedBinding,
	resolveActiveManagedProvider,
	resolveReceiverKind,
} from '$lib/streaming/receiver-experience';
import CustomEndpointForm from './server/CustomEndpointForm.svelte';
import DestinationSection from './server/DestinationSection.svelte';
import RelayServerSelector from './server/RelayServerSelector.svelte';
import ServerIngestSlots from './server/ServerIngestSlots.svelte';
import StreamTuningSection from './server/StreamTuningSection.svelte';
import TransportBadge from './server/TransportBadge.svelte';

interface Props {
	open?: boolean;
}
let { open = $bindable(false) }: Props = $props();

const PORT = streamingConstraints.port;
const LAT = streamingConstraints.srtLatency;
const LATENCY_FALLBACK = Math.min(Math.max(2000, LAT.min), LAT.max);
const LATENCY_STEP = 50;

const config = $derived(getConfig());
const relays = $derived(getRelays());
const isStreaming = $derived(Boolean(getIsStreaming()));

// Managed-cloud surfaces (managed destination + ingest slots) require pairing to
// a managed provider — multi-cloud safe (never a single-provider literal). The
// custom/self-hosted receiver path stays available regardless.
const pairedToManaged = $derived(isPairedToManagedCloud());

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
	selected_slot?: string;
};
let draft = $state<Draft>({});

// Platform-managed ingest slots (T19). When present they supersede the relay
// catalog selector inside the managed destination: the slot auto-resolves (one
// slot → silent; many → default/last-used else prompt) and the operator can
// one-tap switch. The manual custom endpoint remains the always-available
// fallback via the destination radiogroup.
const managedAccounts = $derived(getManagedIngestAccounts());
const hasManagedSlots = $derived(managedAccounts.length > 0);
const slotSelection = $derived(
	autoSelectIngestSlot(managedAccounts, getSelectedIngestEndpoint()),
);
const autoSlotId = $derived(
	slotSelection.kind === 'managed' ? slotSelection.account.endpointId : undefined,
);
const activeSlotId = $derived(draft.selected_slot ?? autoSlotId);
const activeSlot = $derived(
	managedAccounts.find((account) => account.endpointId === activeSlotId),
);
const slotPrompting = $derived(hasManagedSlots && activeSlot === undefined);

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

// Multi-cloud provider picker (T12): the offerable managed providers are DERIVED
// from the catalog the paired cloud(s) pushed — never a hardcoded list — so a
// device paired only to BELABOX offers only BELABOX, and a future managed cloud
// appears as soon as its servers arrive. Custom/self-hosted is never here; it is
// the always-available destination radiogroup escape hatch. The picker is shown
// only when more than one managed provider is offered; a single provider
// auto-selects (select-not-fill), and its single server/transport seed via T10.
const managedProviderOptions = $derived(availableManagedProviders(serverEntries, configProvider));
const showProviderPicker = $derived(managedProviderOptions.length > 1);
const providerLabels = $derived.by(() => {
	const labels: Record<string, string> = {};
	for (const option of managedProviderOptions) {
		labels[option.id] =
			option.name ?? CLOUD_PROVIDERS.find((p) => p.id === option.id)?.name ?? option.id;
	}
	return labels;
});
const selectedProvider = $derived(
	resolveActiveManagedProvider(managedProviderOptions, configProvider, draft.relay_provider),
);
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

// Stream-tuning (Task 16): a managed CeraLive cloud is the only proven CeraLive
// receiver — a custom/self-hosted endpoint is conservatively non-CeraLive. The
// capability descriptor projects the engine's advertised profiles/FEC/latency
// onto the receiver kind; the experience decides which tuning controls the card
// offers and the disabled reason for the rest.
const receiverProfileKind = $derived(
	destination === 'managed' ? deriveReceiverProfileKind(config?.remote_provider) : 'unknown',
);
const engineCaps = $derived(getCapabilities());
const streamTuning = $derived(
	deriveStreamTuningExperience(
		deriveReceiverCaps(receiverProfileKind, {
			supportedProfiles: engineCaps?.supported_profiles,
			fecCapable: engineCaps?.fec_capable,
			latencyRange: engineCaps?.latency_range,
		}),
	),
);

// Seed the persisted transport from the selected managed server's advertised set
// (T10): SRTLA when offered, else its first transport. Now fires for a SINGLE
// advertised transport too — previously only multi-transport servers re-seeded,
// so a single-transport server whose only transport differed from the draft left
// a stale relay_protocol. The per-server chooser stays the single user-facing
// writer; this only seeds a valid default when the draft protocol is unsupported.
$effect(() => {
	if (destination !== 'managed') return;
	const best = autoSelectManagedTransport(relayServerProtocols, protocol);
	if (best && draft.relay_protocol !== best) draft.relay_protocol = best;
});

// Auto-select the managed relay server for the active provider (T10), the catalog
// mirror of the ingest-slot rule: exactly one offered → silent; many → default,
// else last-used; many with neither → leave the operator to pick. Only the
// selected provider's servers are considered, so this never silently jumps
// clouds. Respects an existing/persisted selection and stands down when platform
// ingest slots own the managed path; the custom fallback is always reachable.
$effect(() => {
	if (destination !== 'managed' || hasManagedSlots) return;
	if (draft.relay_server !== undefined || relayServer !== '') return;
	const selection = autoSelectManagedRelay(serverEntries, config?.relay_server, selectedProvider);
	if (selection && selection.kind !== 'prompt') {
		draft.relay_server = selection.serverId;
	}
});

const relayOverride = $derived(draft.relay_override ?? false);
const overrideAddr = $derived(draft.relay_override_addr ?? relayServerInfo?.addr ?? '');
const overridePortStr = $derived(
	draft.relay_override_port ?? (relayServerInfo?.port?.toString() ?? ''),
);

// T18 Fix 3: a relay_server saved under a PREVIOUS provider (the operator switched
// cloud in CloudRemoteDialog without re-selecting) is otherwise invisible here.
// Guard on a loaded catalog so a still-loading relay list never false-warns.
const relayServerStale = $derived(
	destination === 'managed' &&
		relays !== undefined &&
		isRelayServerStaleForProvider(relayServer, serverEntries, selectedProvider),
);

// T18 Fix 2: a manual endpoint override on a bound managed server drops the
// relay_server binding on save (buildServerSetConfig's override branch persists
// srtla_addr/port, no relay_server) — surface it before the operator saves.
const overrideClearsBinding = $derived(
	overrideClearsManagedBinding({ destination, relayOverride, relayServer }),
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
		? kind === 'rist_custom'
			? $LL.settings.errors.receiverAddressRequired()
			: $LL.settings.errors.srtlaServerAddressRequired()
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
	// Managed ingest slots: saveable once a slot is resolved/picked.
	if (hasManagedSlots) return activeSlot !== undefined;
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
			protocol,
		});
		validation = reduceValidateResult(result);
	} catch (error) {
		validation = reduceValidateError(error);
	}
}

async function handleSave() {
	// A resolved managed slot persists its endpoint + the stable
	// selected_ingest_endpoint identity; every other path keeps today's field set.
	const input =
		destination === 'managed' && hasManagedSlots && activeSlot
			? buildManagedSlotConfig(activeSlot, clampLatency(latency))
			: buildServerSetConfig(
					{
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
					} satisfies ServerSetDraft,
					{ destination, relayOverride } satisfies ServerSetDerived,
				);
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
	closeOnPrimary={false}
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
			pairedToManagedCloud={pairedToManaged}
			{relays}
			remoteProvider={config?.remote_provider}
			selected={destination}
		/>

		<!-- Endpoint config, immediately under the destination pick. -->
		{#if destination === 'managed' && pairedToManaged && hasManagedSlots}
			<ServerIngestSlots
				accounts={managedAccounts}
				activeEndpointId={activeSlotId}
				{isStreaming}
				onSelectSlot={(value) => (draft.selected_slot = value)}
				prompting={slotPrompting}
			/>
		{:else if destination === 'managed'}
			{#if relayServerStale}
				<p
					class="border-status-warning/30 bg-status-warning/10 text-status-warning flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
					data-testid="relay-stale-warning"
					role="status"
				>
					<TriangleAlert class="mt-0.5 size-4 shrink-0" />
					<span>{$LL.settings.relayServerStale()}</span>
				</p>
			{/if}
			<RelayServerSelector
				{accountEntries}
				{filteredServerEntries}
				{isStreaming}
				managedProviders={managedProviderOptions}
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
				{providerLabels}
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
				{showProviderPicker}
			/>
			{#if overrideClearsBinding}
				<p
					class="border-status-warning/30 bg-status-warning/10 text-status-warning flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
					data-testid="relay-override-warning"
					role="status"
				>
					<TriangleAlert class="mt-0.5 size-4 shrink-0" />
					<span>{$LL.settings.relayOverrideClearsBinding()}</span>
				</p>
			{/if}
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

		<!-- Stream Tuning (Task 16): receiver-capability-gated profile controls.
		     CeraLive receiver → full controls; non-CeraLive → latency only +
		     disabled-with-reason advanced controls + BELABOX-compatible banner. -->
		<StreamTuningSection experience={streamTuning} {isStreaming} latencyMs={latency} />

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
