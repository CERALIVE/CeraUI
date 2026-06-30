<!--
  RelayServerSelector.svelte — the managed-relay endpoint surface.

  The destination IS the provider now (chosen in DestinationSection), so this no
  longer hosts a provider picker, a manual-endpoint override, or a transport
  chooser — SRTLA is the only transport. It renders the fetched, prefilled server
  selector (with RTT), the read-only auto-resolved endpoint, the optional account
  selector, and the editable Stream ID. Presentational: the container owns state.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { RelayAccount, RelayServer } from '@ceraui/rpc/schemas';

import RelayRttIndicator from '$lib/components/streaming/RelayRttIndicator.svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';

interface Props {
	isStreaming: boolean;
	relaysUnavailable: boolean;
	relayServer: string;
	relayServerName?: string;
	relayServerRtt?: number;
	relayServerEndpoint?: string;
	serverEntries: [string, RelayServer][];
	accountEntries: [string, RelayAccount][];
	relayAccount: string;
	relayAccountName?: string;
	relayStreamId: string;
	onServer: (value: string) => void;
	onAccount: (value: string) => void;
	onRelayStreamId: (value: string) => void;
}

let {
	isStreaming,
	relaysUnavailable,
	relayServer,
	relayServerName,
	relayServerRtt,
	relayServerEndpoint,
	serverEntries,
	accountEntries,
	relayAccount,
	relayAccountName,
	relayStreamId,
	onServer,
	onAccount,
	onRelayStreamId,
}: Props = $props();
</script>

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
				{#each serverEntries as [id, info] (id)}
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

<div class="space-y-2">
	<Label class="text-sm font-medium" for="relay-endpoint">{$LL.settings.autoEndpoint()}</Label>
	<output
		id="relay-endpoint"
		class="bg-muted/60 text-muted-foreground block rounded-md border px-3 py-2 font-mono text-sm"
	>
		{relayServerEndpoint ?? relayServerName ?? '—'}
	</output>
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
