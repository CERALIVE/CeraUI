<!--
  RelayServerSelector.svelte — the managed-relay path of ServerDialog.

  Presentational: ServerDialog owns the draft/derived state and the save handler;
  this component renders the provider selector, the relay-server selector (with
  RTT), the auto-preloaded endpoint (READ-ONLY by default with a manual-override
  toggle revealing editable host/port), the optional account selector, and the
  editable Stream ID.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { RelayAccount, RelayProtocol, RelayServer } from '@ceraui/rpc/schemas';

import RelayRttIndicator from '$lib/components/streaming/RelayRttIndicator.svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';

interface Props {
	isStreaming: boolean;
	relaysUnavailable: boolean;
	selectedProvider: string;
	managedProviders: readonly string[];
	providerLabels: Record<string, string>;
	relayServer: string;
	relayServerName?: string;
	relayServerRtt?: number;
	relayServerEndpoint?: string;
	filteredServerEntries: [string, RelayServer][];
	/**
	 * Transports the selected catalog server advertises (T1
	 * `serverSupportedProtocols`). A length > 1 reveals the compact transport
	 * chooser; the chooser is the SINGLE writer of `draft.relay_protocol` (via
	 * `onProtocol`) so the persisted protocol matches the chosen kind.
	 */
	serverProtocols: readonly RelayProtocol[];
	relayProtocol: RelayProtocol;
	relayOverride: boolean;
	overrideAddr: string;
	overridePortStr: string;
	overridePortError?: string;
	port: { min: number; max: number };
	accountEntries: [string, RelayAccount][];
	relayAccount: string;
	relayAccountName?: string;
	relayStreamId: string;
	onProvider: (value: string) => void;
	onServer: (value: string) => void;
	onProtocol: (value: RelayProtocol) => void;
	onToggleOverride: () => void;
	onOverrideAddr: (value: string) => void;
	onOverridePort: (value: string) => void;
	onAccount: (value: string) => void;
	onRelayStreamId: (value: string) => void;
}

let {
	isStreaming,
	relaysUnavailable,
	selectedProvider,
	managedProviders,
	providerLabels,
	relayServer,
	relayServerName,
	relayServerRtt,
	relayServerEndpoint,
	filteredServerEntries,
	serverProtocols,
	relayProtocol,
	relayOverride,
	overrideAddr,
	overridePortStr,
	overridePortError,
	port,
	accountEntries,
	relayAccount,
	relayAccountName,
	relayStreamId,
	onProvider,
	onServer,
	onProtocol,
	onToggleOverride,
	onOverrideAddr,
	onOverridePort,
	onAccount,
	onRelayStreamId,
}: Props = $props();

// Show the transport chooser only when the selected server honors more than one
// transport (e.g. an endpoint serving both SRTLA and RIST).
const showTransportChooser = $derived(serverProtocols.length > 1);

function protocolBadge(protocol: RelayProtocol): string {
	if (protocol === 'rist') return $LL.settings.transportKindBadge.rist();
	if (protocol === 'srt') return $LL.settings.transportKindBadge.srt();
	return $LL.settings.transportKindBadge.srtlaBonded();
}
</script>

<div class="space-y-2">
	<Label class="text-sm font-medium" for="relay-provider">{$LL.settings.relayProvider()}</Label>
	<Select.Root
		disabled={relaysUnavailable || isStreaming}
		onValueChange={onProvider}
		type="single"
		value={selectedProvider}
	>
		<Select.Trigger id="relay-provider" class="w-full">
			{providerLabels[selectedProvider] ?? selectedProvider}
		</Select.Trigger>
		<Select.Content>
			<Select.Group>
				{#each managedProviders as providerId (providerId)}
					<Select.Item value={providerId}>{providerLabels[providerId]}</Select.Item>
				{/each}
			</Select.Group>
		</Select.Content>
	</Select.Root>
</div>

<div class="space-y-2">
	<Label class="text-sm font-medium" for="relay-server">{$LL.settings.relayServer()}</Label>
	<Select.Root
		disabled={relaysUnavailable || isStreaming}
		onValueChange={onServer}
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

<!-- Transport chooser: only when the selected server advertises more than one
     transport. This is the single writer of the persisted protocol for a managed
     server, so the chosen kind round-trips to the saved `relay_protocol`. -->
{#if showTransportChooser}
	<div class="space-y-2">
		<Label class="text-sm font-medium" for="relay-transport-kind">
			{$LL.settings.transportKind()}
		</Label>
		<div
			id="relay-transport-kind"
			class="bg-muted grid auto-cols-fr grid-flow-col gap-1 rounded-lg p-1"
			data-testid="relay-transport-kind"
			role="radiogroup"
		>
			{#each serverProtocols as protocol (protocol)}
				<button
					aria-checked={relayProtocol === protocol}
					class="rounded-md px-3 py-2 text-sm font-medium transition-colors {relayProtocol ===
					protocol
						? 'bg-background text-foreground shadow-sm'
						: 'text-muted-foreground hover:text-foreground'}"
					data-protocol={protocol}
					data-testid={`relay-protocol-${protocol}`}
					disabled={isStreaming}
					onclick={() => onProtocol(protocol)}
					role="radio"
					type="button"
				>
					{protocolBadge(protocol)}
				</button>
			{/each}
		</div>
	</div>
{/if}

<!-- Auto-preloaded endpoint: read-only by default, with a manual override toggle. -->
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
			onclick={onToggleOverride}
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
			oninput={(e) => onOverrideAddr(e.currentTarget.value)}
			placeholder={$LL.settings.placeholders.srtlaServerAddress()}
			value={overrideAddr}
		/>
		<Input
			id="relay-override-port"
			aria-invalid={overridePortError ? 'true' : undefined}
			class="font-mono"
			disabled={isStreaming}
			inputmode="numeric"
			max={port.max}
			min={port.min}
			oninput={(e) => onOverridePort(e.currentTarget.value)}
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
		disabled={relaysUnavailable || isStreaming}
		onValueChange={onAccount}
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
		oninput={(e) => onRelayStreamId(e.currentTarget.value)}
		placeholder={$LL.settings.placeholders.srtStreamId()}
		value={relayStreamId}
	/>
</div>
