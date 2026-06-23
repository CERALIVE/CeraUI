<!--
  DestinationSection.svelte — leads ServerDialog with WHERE the stream is sent.

  Presentational (Task 6): ServerDialog owns the draft/derived state and the
  selection handler; this section only renders the two destination choices and
  reports the operator's pick through `onDestination`.

  Two choices, modeled as a single-select radio group:
   • My cloud account — a managed relay tied to the operator's cloud account.
     Gated off (D6) while the relay catalog is missing/empty, with the matching
     waiting / none hint; the label is provider-aware (CeraLive / BELABOX).
   • Custom receiver — a self-entered SRTLA address/port. Always available, so it
     stays the reachable fallback whether or not relays have loaded.

  Both choices are additionally locked while a stream is live (stop to change).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Cloud, Plug } from '@lucide/svelte';
import type { ProviderSelection, RelayMessage } from '@ceraui/rpc/schemas';

import { Label } from '$lib/components/ui/label';
import { countRelayServersForProvider } from '$lib/streaming/receiver-experience';

type Destination = 'managed' | 'custom';

interface Props {
	/** The currently-selected destination — drives `aria-checked`. */
	selected: Destination;
	/** A live stream locks both choices (config changes need a stop first). */
	isStreaming: boolean;
	/** Relay catalog: `undefined` = waiting, empty servers = none (D6 gate). */
	relays: RelayMessage | undefined;
	/** Device's configured cloud provider — drives the provider-aware label. */
	remoteProvider?: ProviderSelection;
	/**
	 * Whether the device is paired to a MANAGED cloud provider (multi-cloud safe:
	 * never a single-provider check). Gates the managed choice in addition to D6;
	 * the custom receiver stays available regardless. Defaults to `true` so the
	 * D6 gate is unchanged unless the container threads the real pairing state.
	 */
	pairedToManagedCloud?: boolean;
	onDestination: (kind: Destination) => void;
}

let {
	selected,
	isStreaming,
	relays,
	remoteProvider,
	pairedToManagedCloud = true,
	onDestination,
}: Props = $props();

// Brand product names are not translated (i18n branding convention), so the
// provider-aware managed label is a brand literal; it falls back to the generic
// `destinationManaged` copy when no managed provider is configured.
const PROVIDER_LABELS: Partial<Record<ProviderSelection, string>> = {
	ceralive: 'CeraLive Cloud',
	belabox: 'BELABOX Cloud',
};

const managedLabel = $derived(
	(remoteProvider ? PROVIDER_LABELS[remoteProvider] : undefined) ??
		$LL.settings.destinationManaged(),
);

// D6 relay gate: managed is unavailable while the catalog is missing (waiting)
// or present-but-empty (none). `getRelays()` is `undefined` until the cloud
// provider's cache populates (never in mock/dev), and may arrive empty.
//
// Per-provider (T10): the count is scoped to the SELECTED (configured) provider,
// so a multi-provider catalog only enables managed when THIS provider has
// servers. Untagged legacy servers belong to the active provider, so a
// single-provider catalog still counts in full (no behaviour change).
const providerForGate = $derived(
	remoteProvider && remoteProvider !== 'custom' ? remoteProvider : 'ceralive',
);
const serverCount = $derived(
	relays === undefined
		? 0
		: countRelayServersForProvider(Object.entries(relays.servers), providerForGate),
);
const managedUnavailable = $derived(relays === undefined || serverCount === 0);
const managedGateHint = $derived(
	relays === undefined ? $LL.notifications.relayWaiting() : $LL.notifications.relayNone(),
);

const managedDisabled = $derived(isStreaming || managedUnavailable || !pairedToManagedCloud);
const customDisabled = $derived(isStreaming);

// The managed hint reflects the gate, in priority order: the D6 relay gate
// (waiting / none) first, then the pairing gate (pair to a managed cloud first),
// else the plain description. The custom receiver is never gated by either.
const managedHint = $derived(
	managedUnavailable
		? managedGateHint
		: !pairedToManagedCloud
			? $LL.settings.index.pairingDesc()
			: $LL.settings.destinationManagedHint(),
);

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
		<button
			aria-checked={selected === 'managed'}
			class="{choiceBase} {selected === 'managed' ? activeChoice : idleChoice}"
			data-testid="destination-managed"
			disabled={managedDisabled}
			onclick={() => onDestination('managed')}
			role="radio"
			type="button"
		>
			<Cloud class="text-primary mt-0.5 size-5 shrink-0" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-foreground text-sm font-medium">{managedLabel}</span>
				<span class="text-muted-foreground text-xs leading-snug">{managedHint}</span>
			</span>
		</button>

		<button
			aria-checked={selected === 'custom'}
			class="{choiceBase} {selected === 'custom' ? activeChoice : idleChoice}"
			data-testid="destination-custom"
			disabled={customDisabled}
			onclick={() => onDestination('custom')}
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
