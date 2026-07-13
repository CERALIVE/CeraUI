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
import { Server } from '@lucide/svelte';
import type { ConfigMessage, RelayProtocol } from '@ceraui/rpc/schemas';
import { untrack } from 'svelte';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import type { FederationHostAdapter } from '$lib/federation/host-contract';
import {
	buildRelayValidationInput,
	canSaveServer,
	filterProviderEntries,
	relayEndpoint,
	serverEndpointErrors,
	type ServerDraft,
} from '$lib/federation/server-model';
import { parsePort, streamingConstraints } from '$lib/components/streaming/ValidationAdapter';
import type { Validation } from '$lib/components/streaming/relay-validation';
import {
	getCapabilities,
	getConfig,
	getIsStreaming,
	getManagedIngestAccounts,
	getRelays,
	getSelectedIngestEndpoint,
} from '$lib/rpc/subscriptions.svelte';
import {
	type ReceiverDestinationChoice,
	autoSelectIngestSlot,
	autoSelectManagedRelay,
	choiceToDestination,
	deriveDestinationChoice,
	deriveLatencyRange,
	isManagedChoice,
} from '$lib/streaming/receiver-experience';
import { fingerprintForValidation } from '$lib/streaming/destination-validation.svelte';
import CloudRemoteDialog from './CloudRemoteDialog.svelte';
import ServerDialogContent from './server/ServerDialogContent.svelte';
import {
	buildServerDialogInput,
	saveServerConfig,
	validateServerEndpoint,
} from './server/server-dialog-commands';

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
const endpointErrors = $derived(serverEndpointErrors({
	destination,
	portStr,
	port: portNum,
	draftAddr: draft.srtla_addr,
	portRangeMessage: $LL.validation.portRange(),
	addressRequiredMessage: $LL.settings.errors.srtlaServerAddressRequired(),
}));
const portError = $derived(endpointErrors.port);
const addrError = $derived(endpointErrors.address);

const canValidate = $derived(
	!isStreaming &&
		addr.trim() !== '' &&
		portStr.trim() !== '' &&
		portError === undefined &&
		validation.state !== 'validating',
);

const canSave = $derived(canSaveServer({
	destination, isStreaming, addr, portStr, hasPortError: portError !== undefined,
	validation, selectedManagedActive, hasManagedSlots,
	hasActiveSlot: activeSlot !== undefined, relayServer,
}));

function resetValidation() {
	if (validation.state !== 'idle') validation = { state: 'idle' };
}

function openCloudRemote(provider: ReceiverDestinationChoice) {
	cloudRemoteProvider = provider;
	cloudRemoteOpen = true;
}

async function handleValidate() {
	validation = { state: 'validating' };
	const input = buildRelayValidationInput(addr, portNum, streamId, passphrase, PROTOCOL);
	validation = await validateServerEndpoint(hostAdapter, input);
}

async function handleSave() {
	const input = buildServerDialogInput({
		managedSlot: destination === 'managed' && selectedManagedActive && hasManagedSlots
			? activeSlot : undefined,
		latency: clampedLatency, protocol: PROTOCOL, addr, portStr, streamId,
		relayStreamId, relayServer, relayAccount: effectiveRelayAccount, destination,
	});
	const result = await saveServerConfig({
		hostAdapter,
		input,
		onSaved,
		savedMessage: $LL.notifications.saved(),
		failedMessage: $LL.notifications.saveFailed(),
	});
	if (result.kind === 'applied-latency') appliedLatencyMs = result.value;
	if (result.kind === 'close') {
		appliedLatencyMs = undefined;
		open = false;
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
	<ServerDialogContent
		{isStreaming} {catalogDrift} {activeProvider} {relays} {destinationChoice} {destination}
		{selectedManagedActive} {hasManagedSlots} {managedAccounts} {activeSlotId} {slotPrompting}
		{filteredAccountEntries} {filteredServerEntries} {effectiveRelayAccount} {relayAccountName}
		{relayServer} {relayServerEndpoint} {relayServerName} {relayServerRtt} {relayStreamId}
		{addr} {addrError} {canValidate} {passphrase} port={PORT} {portError} {portStr} {streamId}
		{validation} {appliedLatencyMs} {effectiveLatencyMs} {clampedLatency} {latencyRange}
		onDestination={(value) => (draft.destination_choice = value)}
		onSlot={(value) => (draft.selected_slot = value)}
		onAccount={(value) => (draft.relay_account = value)}
		onRelayStreamId={(value) => (draft.relay_streamid = value)}
		onServer={(value) => (draft.relay_server = value)}
		onAddKey={() => openCloudRemote(destinationChoice)}
		onAddr={(value) => { draft.srtla_addr = value; resetValidation(); }}
		onPassphrase={(value) => { draft.passphrase = value; resetValidation(); }}
		onPort={(value) => { draft.srtla_port = value; resetValidation(); }}
		onStreamId={(value) => { draft.srt_streamid = value; resetValidation(); }}
		onValidate={handleValidate}
		onLatency={(value) => { draft.srt_latency = value; appliedLatencyMs = undefined; }}
	/>
</AppDialog>

<CloudRemoteDialog bind:open={cloudRemoteOpen} provider={cloudRemoteProvider} />
