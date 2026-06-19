<!--
  ServerReadiness.svelte — calm, read-only bonded-links readiness hint for the
  Live server surface (T13).

  SRTLA is the ONLY wired bonded path, so it is the only kind that asserts a
  "Bonded across N links" claim — and only while streaming, when the live link
  count from `getLinkTelemetry()` is actually known. When not streaming the count
  is null and the hint degrades to the transport label alone (never a stale
  count). RIST / plain-SRT make no bonding claim: they read as a fixed single
  link with an InfoPopover explaining the intended topology (RIST egress is
  resolver-only — see docs/RECEIVER_MODEL.md §4).

  Purely presentational: the readiness decision is the pure, unit-tested
  `deriveServerReadiness` (lib/streaming/receiver-experience); the transport
  label copy is the shared `kindBadgeLabelKey` resolved through the `$LL` proxy.
  Motion is CSS-only; no Svelte motion directives.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Link2, Network } from '@lucide/svelte';
import type { ReceiverKind } from '@ceraui/rpc/schemas';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { deriveServerReadiness, kindBadgeLabelKey } from '$lib/streaming/receiver-experience';

interface Props {
	/** The resolved receiver kind (transport × destination). */
	kind: ReceiverKind;
	/**
	 * Live active-link count, or `null` when not streaming (`getLinkTelemetry()`
	 * is null while idle). Null degrades SRTLA to a label-only hint — never a
	 * stale count.
	 */
	linkCount: number | null;
	/** Navigate to the Network destination to manage bonded links. */
	onManageLinks: () => void;
}

const { kind, linkCount, onManageLinks }: Props = $props();

const readiness = $derived(deriveServerReadiness(kind, linkCount));

const t = (key: string): string => {
	let result: unknown = $LL;
	for (const part of key.split('.')) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

const transportLabel = $derived(t(kindBadgeLabelKey(kind)));
const showManageLinks = $derived(
	readiness.variant === 'bonded' || readiness.variant === 'single',
);
</script>

<div
	class="bg-muted/30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border px-4 py-3"
	data-readiness-variant={readiness.variant}
	data-testid="server-readiness"
>
	<div class="flex items-center gap-2">
		<Link2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
		<span class="text-sm font-medium">{transportLabel}</span>

		{#if readiness.variant === 'bonded'}
			<span class="text-muted-foreground text-sm" data-testid="server-readiness-bonded">
				{$LL.live.server.bondedAcross({ count: readiness.count })}
			</span>
		{:else if readiness.variant === 'single'}
			<span class="text-muted-foreground text-sm" data-testid="server-readiness-single">
				{$LL.live.server.singleLink()}
			</span>
		{:else if readiness.variant === 'fixed'}
			<span class="text-muted-foreground flex items-center gap-1 text-sm">
				<span data-testid="server-readiness-fixed">{$LL.live.server.singleLink()}</span>
				<InfoPopover
					body={$LL.live.server.singleLinkHint()}
					testId="server-readiness-info"
					title={$LL.live.server.singleLink()}
				/>
			</span>
		{/if}
	</div>

	{#if showManageLinks}
		<button
			class="hover:bg-accent focus-visible:ring-ring/50 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-0"
			data-testid="manage-links"
			onclick={onManageLinks}
			type="button"
		>
			<Network aria-hidden={true} class="size-4 shrink-0" />
			{$LL.live.server.manageLinks()}
		</button>
	{/if}
</div>
