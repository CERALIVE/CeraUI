<!--
  DestinationSection.svelte — the destination IS the provider choice.

  Three tiles in one radiogroup: each managed cloud (CeraLive Cloud / BELABOX
  Cloud, derived from CLOUD_PROVIDERS) plus a Custom receiver. The managed cloud
  the device currently holds a key for (`activeProvider`) shows its normal
  description and the D6 relay-availability hint (waiting / none); any other
  managed cloud shows a calm "add your key" prompt and, when picked, leads the
  container to open CloudRemoteDialog preselecting it. Custom is always reachable.

  Presentational: the container owns the selection state and the handler; this
  section only renders the tiles and reports the pick via `onSelect`.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Cloud, Plug } from '@lucide/svelte';
import type { ProviderSelection, RelayMessage } from '@ceraui/rpc/schemas';

import { Label } from '$lib/components/ui/label';
import {
	type ReceiverDestinationChoice,
	countRelayServersForProvider,
	MANAGED_DESTINATION_CHOICES,
	managedCloudLabel,
} from '$lib/streaming/receiver-experience';

interface Props {
	/** The currently-selected destination choice — drives `aria-checked`. */
	selected: ReceiverDestinationChoice;
	/** The managed cloud the device currently holds a key for (config.remote_provider). */
	activeProvider?: ProviderSelection;
	/** A live stream locks every choice (config changes need a stop first). */
	isStreaming: boolean;
	/** Relay catalog: `undefined` = waiting, empty servers = none (D6 gate). */
	relays: RelayMessage | undefined;
	onSelect: (choice: ReceiverDestinationChoice) => void;
}

let { selected, activeProvider, isStreaming, relays, onSelect }: Props = $props();

const serverEntries = $derived(relays === undefined ? [] : Object.entries(relays.servers));

function isActive(choice: ReceiverDestinationChoice): boolean {
	return choice === activeProvider;
}

function managedUnavailable(choice: ReceiverDestinationChoice): boolean {
	return relays === undefined || countRelayServersForProvider(serverEntries, choice) === 0;
}

function managedHint(choice: ReceiverDestinationChoice): string {
	if (!isActive(choice)) {
		return $LL.settings.destinationNeedsKey({ cloud: managedCloudLabel(choice) });
	}
	if (relays === undefined) return $LL.notifications.relayWaiting();
	if (countRelayServersForProvider(serverEntries, choice) === 0) {
		return $LL.notifications.relayNone();
	}
	return $LL.settings.destinationManagedHint();
}

function managedDisabled(choice: ReceiverDestinationChoice): boolean {
	if (isStreaming) return true;
	return isActive(choice) && managedUnavailable(choice);
}

const choiceBase =
	'flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-start ' +
	'transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const activeChoice = 'border-primary bg-primary/10 text-foreground';
const idleChoice = 'border-border text-muted-foreground hover:text-foreground';
</script>

<div class="space-y-2">
	<Label class="text-sm font-medium" id="destination-label">{$LL.settings.destination()}</Label>
	<div
		aria-label={$LL.settings.destination()}
		class="grid gap-2"
		data-testid="destination"
		role="radiogroup"
	>
		{#each MANAGED_DESTINATION_CHOICES as choice (choice)}
			<button
				aria-checked={selected === choice}
				class="{choiceBase} {selected === choice ? activeChoice : idleChoice}"
				data-testid={`destination-${choice}`}
				disabled={managedDisabled(choice)}
				onclick={() => onSelect(choice)}
				role="radio"
				type="button"
			>
				<Cloud class="text-primary mt-0.5 size-5 shrink-0" />
				<span class="flex min-w-0 flex-col gap-0.5">
					<span class="text-foreground text-sm font-medium">{managedCloudLabel(choice)}</span>
					<span class="text-muted-foreground text-xs leading-snug">{managedHint(choice)}</span>
				</span>
			</button>
		{/each}

		<button
			aria-checked={selected === 'custom'}
			class="{choiceBase} {selected === 'custom' ? activeChoice : idleChoice}"
			data-testid="destination-custom"
			disabled={isStreaming}
			onclick={() => onSelect('custom')}
			role="radio"
			type="button"
		>
			<Plug class="text-primary mt-0.5 size-5 shrink-0" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-foreground text-sm font-medium">{$LL.settings.destinationCustom()}</span>
				<span class="text-muted-foreground text-xs leading-snug"
					>{$LL.settings.destinationCustomHint()}</span
				>
			</span>
		</button>
	</div>
</div>
