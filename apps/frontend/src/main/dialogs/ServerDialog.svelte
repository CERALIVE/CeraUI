<!--
  ServerDialog.svelte — receiver/server configuration, surfaced from Live.

  Destination-as-provider model (receiver-coherence). The destination IS the
  provider choice and leads the dialog:

   1. Streaming-lock banner — config changes need a stop first.
   2. DestinationSection — three tiles: CeraLive Cloud · BELABOX Cloud · Custom
      receiver. Picking the managed cloud the device holds a key for shows its
      servers; picking another managed cloud shows a calm "add your key" prompt
      that opens CloudRemoteDialog preselecting it.
   3. TransportRow — honest transport row: SRTLA active, RIST/SRT coming soon.
      Hidden ONLY for BeLABOX (SRTLA-only receiver, no RIST/SRT roadmap); shown
      for CeraLive and Custom.
   4. Endpoint config:
        • managed (keyed) → ServerIngestSlots or RelayServerSelector (fetched
          servers, prefilled; no provider picker, no override).
        • managed (unkeyed) → "add your key" prompt.
        • custom → CustomEndpointForm (SRTLA address/port/streamid/secret +
          relay.validate).
   5. LatencySection — the single honest tuning control (ARQ retransmit budget).

  Reliability is automatic (SRT ARQ over SRTLA bonding, always on) so latency is
  the only knob — no FEC, recovery, presets, or cloud-override controls. The save
  handler delegates the persisted-field set to `buildServerSetConfig` /
  `buildManagedSlotConfig` and locks every field before the RPC.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { KeyRound, Server } from '@lucide/svelte';
import type { ConfigMessage, RelayProtocol } from '@ceraui/rpc/schemas';
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import type { FederationHostAdapter } from '$lib/federation/host-contract';
import {
	buildRelayValidationInput,
	filterProviderEntries,
	relayEndpoint,
	type ServerDraft,
} from '$lib/federation/server-model';
import { Button } from '$lib/components/ui/button';
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
import {
	type ReceiverDestinationChoice,
	type ServerSetDerived,
	type ServerSetDraft,
	autoSelectIngestSlot,
	autoSelectManagedRelay,
	buildManagedSlotConfig,
	buildServerSetConfig,
	choiceToDestination,
	deriveDestinationChoice,
	deriveLatencyRange,
	isManagedChoice,
	managedCloudLabel,
} from '$lib/streaming/receiver-experience';
import { fingerprintForValidation } from '$lib/streaming/destination-validation.svelte';
import CloudRemoteDialog from './CloudRemoteDialog.svelte';
import CustomEndpointForm from './server/CustomEndpointForm.svelte';
import DestinationSection from './server/DestinationSection.svelte';
import LatencySection from './server/LatencySection.svelte';
import RelayServerSelector from './server/RelayServerSelector.svelte';
import ServerIngestSlots from './server/ServerIngestSlots.svelte';
import TransportRow from './server/TransportRow.svelte';

interface Props {
	open?: boolean;
	/**
	 * OPTIONAL "saved" signal (Task 5, federation-safe). Fired AFTER a successful
	 * save so a host surface (LiveView) can run an informational `relay.validate`
	 * check on the saved endpoint. Defaults to a no-op: the save path NEVER awaits
	 * or depends on it, and the mount contract stays `{ open? }`-compatible so a
	 * federated bundle that lacks the RPC still mounts + saves normally.
	 */
	onSaved?: () => void;
	hostAdapter?: FederationHostAdapter;
	initialConfig?: ConfigMessage;
}
let {
	open = $bindable(false),
	onSaved = () => undefined,
	hostAdapter,
	initialConfig,
}: Props = $props();

const PORT = streamingConstraints.port;
const PROTOCOL: RelayProtocol = 'srtla';

const config = $derived(hostAdapter ? initialConfig : getConfig());
const relays = $derived(getRelays());
const isStreaming = $derived(Boolean(getIsStreaming()));

let draft = $state<ServerDraft>({});

let cloudRemoteOpen = $state(false);
let cloudRemoteProvider = $state<ReceiverDestinationChoice | undefined>(undefined);
let validation = $state<Validation>({ state: 'idle' });

// The resolved endpoint fingerprint captured when the dialog OPENED. A later
// catalog update (a managed server's addr/port drifting under the same id) that
// changes the current fingerprint surfaces a calm review note — never an
// auto-mutation, never a save block. Captured via `untrack` so this reset effect
// stays keyed on `open` alone (re-capturing on every catalog tick would defeat
// the drift comparison).
let openFingerprint = $state<string | undefined>(undefined);
// The latency value the backend APPLIED after its floor clamp, when it differs
// from the requested value — drives LatencySection's applied-value notice.
let appliedLatencyMs = $state<number | undefined>(undefined);

$effect(() => {
	if (open) {
		draft = {};
		validation = { state: 'idle' };
		appliedLatencyMs = undefined;
		openFingerprint = untrack(() =>
			fingerprintForValidation(config, relays, managedAccounts),
		);
	}
});

const destinationChoice = $derived<ReceiverDestinationChoice>(
	draft.destination_choice ?? deriveDestinationChoice(config),
);
const destination = $derived(choiceToDestination(destinationChoice));
const activeProvider = $derived(config?.remote_provider);
const selectedManagedActive = $derived(
	isManagedChoice(destinationChoice) && destinationChoice === activeProvider,
);
const selectedProvider = $derived(isManagedChoice(destinationChoice) ? destinationChoice : 'ceralive');

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

const addr = $derived(draft.srtla_addr ?? config?.srtla_addr ?? '');
const portStr = $derived(draft.srtla_port ?? (config?.srtla_port?.toString() ?? ''));
const streamId = $derived(draft.srt_streamid ?? config?.srt_streamid ?? '');
const passphrase = $derived(draft.passphrase ?? '');
const relayServer = $derived(draft.relay_server ?? config?.relay_server ?? '');
const relayAccount = $derived(draft.relay_account ?? config?.relay_account ?? '');
const relayStreamId = $derived(draft.relay_streamid ?? config?.relay_streamid_override ?? '');

const allServerEntries = $derived(Object.entries(relays?.servers ?? {}));
const allAccountEntries = $derived(Object.entries(relays?.accounts ?? {}));

// Provider-filtered catalog (R-4): only the selected cloud's servers/accounts are
// offered; untagged legacy entries belong to the selected provider.
const filteredServerEntries = $derived(
	filterProviderEntries(allServerEntries, selectedProvider),
);
const filteredAccountEntries = $derived(
	filterProviderEntries(allAccountEntries, selectedProvider),
);
// A persisted account tagged to a different provider is dropped (re-pick).
const effectiveRelayAccount = $derived(
	filteredAccountEntries.some(([id]) => id === relayAccount) ? relayAccount : '',
);

const relayServerInfo = $derived(relays?.servers?.[relayServer]);
const relayServerName = $derived(relayServerInfo?.name);
const relayServerRtt = $derived(relayServerInfo?.rtt);
const relayServerEndpoint = $derived(relayEndpoint(relayServerInfo));
const relayAccountName = $derived(relays?.accounts?.[effectiveRelayAccount]?.name);

const engineCaps = $derived(getCapabilities());
const latencyRange = $derived(deriveLatencyRange({ latency_range: engineCaps?.latency_range }));
const latency = $derived(draft.srt_latency ?? config?.srt_latency ?? latencyRange.default);
const clampedLatency = $derived(
	Math.min(Math.max(latency, latencyRange.min), latencyRange.max),
);
const effectiveLatencyMs = $derived(isStreaming ? config?.srt_latency : undefined);

// Catalog-drift review note: the resolved endpoint fingerprint NOW vs at open.
// A difference means the relays catalog (or a pushed config) moved the endpoint
// under the operator while the dialog was open — surface a calm review line,
// never a warning band, never an auto-mutation, never a save block.
const currentFingerprint = $derived(
	fingerprintForValidation(config, relays, managedAccounts),
);
const catalogDrift = $derived(
	open && openFingerprint !== undefined && currentFingerprint !== openFingerprint,
);

// Auto-select the managed relay server for the active cloud (catalog mirror of
// the ingest-slot rule): exactly one offered → silent; many → default else
// last-used; many with neither → leave the operator to pick. Stands down when
// platform ingest slots own the managed path.
$effect(() => {
	if (destination !== 'managed' || !selectedManagedActive || hasManagedSlots) return;
	if (draft.relay_server !== undefined || relayServer !== '') return;
	const selection = autoSelectManagedRelay(allServerEntries, config?.relay_server, selectedProvider);
	if (selection && selection.kind !== 'prompt') {
		draft.relay_server = selection.serverId;
	}
});

const portNum = $derived(parsePort(portStr));
const portError = $derived.by(() => {
	if (destination !== 'custom' || portStr.trim() === '') return undefined;
	if (!isPortValid(portNum)) return $LL.validation.portRange();
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
	if (!selectedManagedActive) return false;
	if (hasManagedSlots) return activeSlot !== undefined;
	return relayServer !== '';
});

function resetValidation() {
	if (validation.state !== 'idle') validation = { state: 'idle' };
}

function openCloudRemote(provider: ReceiverDestinationChoice) {
	cloudRemoteProvider = provider;
	cloudRemoteOpen = true;
}

async function handleValidate() {
	validation = { state: 'validating' };
	try {
		const input = buildRelayValidationInput(addr, portNum, streamId, passphrase, PROTOCOL);
		const result = await (hostAdapter?.validateRelay(input) ?? rpc.relay.validate(input));
		validation = reduceValidateResult(result);
	} catch (error) {
		validation = reduceValidateError(error);
	}
}

async function handleSave() {
	const input =
		destination === 'managed' && selectedManagedActive && hasManagedSlots && activeSlot
			? buildManagedSlotConfig(activeSlot, clampedLatency)
			: buildServerSetConfig(
					{
						latency: clampedLatency,
						protocol: PROTOCOL,
						addr,
						portStr,
						streamId,
						relayStreamId,
						relayServer,
						relayAccount: effectiveRelayAccount,
					} satisfies ServerSetDraft,
					{ destination } satisfies ServerSetDerived,
				);
	const fields = Object.entries(input);
	for (const [field, value] of fields) markPending(field, value);
	try {
		const result = await (hostAdapter?.setConfig(input) ?? rpc.streaming.setConfig(input));
		toast.success($LL.notifications.saved());
		// Fire-and-forget "saved" signal (never awaited): a host may run an
		// informational relay.validate on the saved endpoint. Save already
		// succeeded above — this must not gate or throw into the save path.
		onSaved();
		// Floor-clamp applied-value notice (C7): the backend floors srt_latency to
		// the SRTLA minimum. When the applied value differs from what we requested,
		// keep the dialog OPEN and surface the notice via LatencySection instead of
		// closing silently. Federation-safe: an absent `applied.srt_latency` (older
		// backend) falls through to today's close-on-save behaviour.
		const requested = input.srt_latency;
		const applied = result?.applied?.srt_latency;
		if (
			requested !== undefined &&
			typeof applied === 'number' &&
			applied !== requested
		) {
			appliedLatencyMs = applied;
		} else {
			appliedLatencyMs = undefined;
			open = false;
		}
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

		{#if catalogDrift}
			<p
				class="text-muted-foreground rounded-lg border px-3 py-2 text-sm"
				data-testid="catalog-drift-note"
				role="status"
			>
				{$LL.settings.catalogDriftNote()}
			</p>
		{/if}

		<DestinationSection
			{activeProvider}
			{isStreaming}
			onSelect={(value) => (draft.destination_choice = value)}
			{relays}
			selected={destinationChoice}
		/>

		{#if destinationChoice !== 'belabox'}
			<TransportRow />
		{/if}

		{#if destination === 'managed' && selectedManagedActive && hasManagedSlots}
			<ServerIngestSlots
				accounts={managedAccounts}
				activeEndpointId={activeSlotId}
				{isStreaming}
				onSelectSlot={(value) => (draft.selected_slot = value)}
				prompting={slotPrompting}
			/>
		{:else if destination === 'managed' && selectedManagedActive}
			<RelayServerSelector
				accountEntries={filteredAccountEntries}
				{isStreaming}
				onAccount={(value) => (draft.relay_account = value)}
				onRelayStreamId={(value) => (draft.relay_streamid = value)}
				onServer={(value) => (draft.relay_server = value)}
				relayAccount={effectiveRelayAccount}
				{relayAccountName}
				relaysUnavailable={relays === undefined}
				{relayServer}
				{relayServerEndpoint}
				{relayServerName}
				{relayServerRtt}
				{relayStreamId}
				serverEntries={filteredServerEntries}
			/>
		{:else if destination === 'managed'}
			<div
				class="border-border bg-muted/40 flex flex-col gap-3 rounded-lg border px-3 py-3"
				data-testid="destination-needs-key"
				role="status"
			>
				<div class="flex items-start gap-2">
					<KeyRound class="text-primary mt-0.5 size-4 shrink-0" />
					<span class="text-muted-foreground text-sm leading-snug">
						{$LL.settings.destinationNeedsKey({ cloud: managedCloudLabel(destinationChoice) })}
					</span>
				</div>
				<Button
					class="w-full"
					data-testid="destination-add-key"
					onclick={() => openCloudRemote(destinationChoice)}
					variant="outline"
				>
					{$LL.settings.destinationAddKey()}
				</Button>
			</div>
		{:else}
			<CustomEndpointForm
				{addr}
				{addrError}
				{canValidate}
				{isStreaming}
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

		<LatencySection
			clampedLatencyMs={appliedLatencyMs}
			{effectiveLatencyMs}
			{isStreaming}
			latencyMs={clampedLatency}
			onLatencyChange={(value) => {
				draft.srt_latency = value;
				// A fresh operator edit supersedes a stale clamp notice.
				appliedLatencyMs = undefined;
			}}
			range={latencyRange}
		/>
	</div>
</AppDialog>

<CloudRemoteDialog bind:open={cloudRemoteOpen} provider={cloudRemoteProvider} />
