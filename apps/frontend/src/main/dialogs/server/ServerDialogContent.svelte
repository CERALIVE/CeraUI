<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LatencyRange, RelayAccount, RelayMessage, RelayServer } from '@ceraui/rpc/schemas';
import { KeyRound } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { Validation } from '$lib/components/streaming/relay-validation';
import type {
	ManagedIngestAccount,
	ReceiverDestinationChoice,
} from '$lib/streaming/receiver-experience';
import { managedCloudLabel } from '$lib/streaming/receiver-experience';
import CustomEndpointForm from './CustomEndpointForm.svelte';
import DestinationSection from './DestinationSection.svelte';
import LatencySection from './LatencySection.svelte';
import RelayServerSelector from './RelayServerSelector.svelte';
import ServerIngestSlots from './ServerIngestSlots.svelte';
import TransportRow from './TransportRow.svelte';

interface Props {
	isStreaming: boolean;
	catalogDrift: boolean;
	activeProvider?: ReceiverDestinationChoice;
	relays?: RelayMessage;
	destinationChoice: ReceiverDestinationChoice;
	destination: 'managed' | 'custom';
	selectedManagedActive: boolean;
	hasManagedSlots: boolean;
	managedAccounts: readonly ManagedIngestAccount[];
	activeSlotId?: string;
	slotPrompting: boolean;
	filteredAccountEntries: [string, RelayAccount][];
	filteredServerEntries: [string, RelayServer][];
	effectiveRelayAccount: string;
	relayAccountName?: string;
	relayServer: string;
	relayServerEndpoint?: string;
	relayServerName?: string;
	relayServerRtt?: number;
	relayStreamId: string;
	addr: string;
	addrError?: string;
	canValidate: boolean;
	passphrase: string;
	port: { readonly min: number; readonly max: number };
	portError?: string;
	portStr: string;
	streamId: string;
	validation: Validation;
	appliedLatencyMs?: number;
	effectiveLatencyMs?: number;
	clampedLatency: number;
	latencyRange: LatencyRange;
	onDestination: (value: ReceiverDestinationChoice) => void;
	onSlot: (value: string) => void;
	onAccount: (value: string) => void;
	onRelayStreamId: (value: string) => void;
	onServer: (value: string) => void;
	onAddKey: () => void;
	onAddr: (value: string) => void;
	onPassphrase: (value: string) => void;
	onPort: (value: string) => void;
	onStreamId: (value: string) => void;
	onValidate: () => void;
	onLatency: (value: number) => void;
}

let props: Props = $props();
</script>

<div class="space-y-5">
	{#if props.isStreaming}
		<p class="rounded-lg border px-3 py-2 text-sm" style="color: var(--status-live); border-color: color-mix(in oklab, var(--status-live) 35%, transparent); background-color: color-mix(in oklab, var(--status-live) 10%, transparent);">{$LL.live.stopToChange()}</p>
	{/if}
	{#if props.catalogDrift}
		<p class="text-muted-foreground rounded-lg border px-3 py-2 text-sm" data-testid="catalog-drift-note" role="status">{$LL.settings.catalogDriftNote()}</p>
	{/if}
	<DestinationSection activeProvider={props.activeProvider} isStreaming={props.isStreaming} onSelect={props.onDestination} relays={props.relays} selected={props.destinationChoice} />
	{#if props.destinationChoice !== 'belabox'}<TransportRow />{/if}
	{#if props.destination === 'managed' && props.selectedManagedActive && props.hasManagedSlots}
		<ServerIngestSlots accounts={props.managedAccounts} activeEndpointId={props.activeSlotId} isStreaming={props.isStreaming} onSelectSlot={props.onSlot} prompting={props.slotPrompting} />
	{:else if props.destination === 'managed' && props.selectedManagedActive}
		<RelayServerSelector
			accountEntries={props.filteredAccountEntries} isStreaming={props.isStreaming}
			onAccount={props.onAccount} onRelayStreamId={props.onRelayStreamId} onServer={props.onServer}
			relayAccount={props.effectiveRelayAccount} relayAccountName={props.relayAccountName}
			relaysUnavailable={props.relays === undefined} relayServer={props.relayServer}
			relayServerEndpoint={props.relayServerEndpoint} relayServerName={props.relayServerName}
			relayServerRtt={props.relayServerRtt} relayStreamId={props.relayStreamId}
			serverEntries={props.filteredServerEntries}
		/>
	{:else if props.destination === 'managed'}
		<div class="border-border bg-muted/40 flex flex-col gap-3 rounded-lg border px-3 py-3" data-testid="destination-needs-key" role="status">
			<div class="flex items-start gap-2"><KeyRound class="text-primary mt-0.5 size-4 shrink-0" /><span class="text-muted-foreground text-sm leading-snug">{$LL.settings.destinationNeedsKey({ cloud: managedCloudLabel(props.destinationChoice) })}</span></div>
			<Button class="w-full" data-testid="destination-add-key" onclick={props.onAddKey} variant="outline">{$LL.settings.destinationAddKey()}</Button>
		</div>
	{:else}
		<CustomEndpointForm
			addr={props.addr} addrError={props.addrError} canValidate={props.canValidate}
			isStreaming={props.isStreaming} onAddr={props.onAddr} onPassphrase={props.onPassphrase}
			onPort={props.onPort} onStreamId={props.onStreamId} onValidate={props.onValidate}
			passphrase={props.passphrase} port={props.port} portError={props.portError}
			portStr={props.portStr} streamId={props.streamId} validation={props.validation}
		/>
	{/if}
	<LatencySection clampedLatencyMs={props.appliedLatencyMs} effectiveLatencyMs={props.effectiveLatencyMs} isStreaming={props.isStreaming} latencyMs={props.clampedLatency} onLatencyChange={props.onLatency} range={props.latencyRange} />
</div>
