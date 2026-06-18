<!--
  CapabilityTierBanner.svelte — capability-tier state surface (Task 9).

  Renders the three non-normal capability tiers the engine can raise on the
  `capabilities` snapshot, each as a CALM, intentional state — never an error
  toast or alert (instrument-clarity tone: a starting engine is expected, not a
  failure). The tier→UI mapping is the pure `capabilityTierViewFor` seam, so this
  component is presentation only.

  • engineUnavailable     → calm muted banner (role="status"); config is paused.
  • engineStarting        → skeleton + spinner (role="status"); "engine starting".
  • schemaVersionMismatch → informational band (role="status"); options approximate.
  • normal                → nothing.

  All copy is `$LL.live.education.tier.*`. The banner stays in normal document
  flow so headless/hidden-tab renders show it without a class-triggered reveal.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CapabilitiesMessage } from '@ceraui/rpc/schemas';
import { Info, LoaderCircle, ServerOff } from '@lucide/svelte';

import { capabilityTierViewFor } from '$lib/components/streaming/capability-tier';
import { Skeleton } from '$lib/components/ui/skeleton';

interface Props {
	/** The live capabilities snapshot (from `getCapabilities()`). */
	caps: CapabilitiesMessage | undefined;
}

let { caps }: Props = $props();

const view = $derived(capabilityTierViewFor(caps));
const tier = $derived(view.tier);
</script>

{#if view.visible}
	{#if tier === 'engineUnavailable'}
		<div
			class="border-border bg-muted/40 flex items-start gap-3 rounded-lg border px-4 py-3"
			data-testid={view.testId}
			role="status"
		>
			<ServerOff aria-hidden={true} class="text-muted-foreground mt-0.5 size-5 shrink-0" />
			<div class="min-w-0 flex-1 space-y-1">
				<p class="text-sm font-semibold">{$LL.live.education.tier.engineUnavailable.title()}</p>
				<p class="text-muted-foreground text-sm">
					{$LL.live.education.tier.engineUnavailable.body()}
				</p>
			</div>
		</div>
	{:else if tier === 'engineStarting'}
		<div
			class="border-border bg-muted/40 space-y-3 rounded-lg border px-4 py-3"
			data-testid={view.testId}
			role="status"
		>
			<div class="flex items-start gap-3">
				<LoaderCircle
					aria-hidden={true}
					class="text-primary mt-0.5 size-5 shrink-0 animate-spin motion-reduce:animate-none"
				/>
				<div class="min-w-0 flex-1 space-y-1">
					<p class="text-sm font-semibold">{$LL.live.education.tier.engineStarting.title()}</p>
					<p class="text-muted-foreground text-sm">
						{$LL.live.education.tier.engineStarting.body()}
					</p>
				</div>
			</div>
			<!-- Skeleton stand-in for the options still loading. -->
			<div class="space-y-2" aria-hidden={true}>
				<Skeleton class="h-4 w-2/3" />
				<Skeleton class="h-9 w-full" />
			</div>
		</div>
	{:else if tier === 'schemaVersionMismatch'}
		<div
			class="border-status-info/30 bg-status-info/10 flex items-start gap-3 rounded-lg border px-4 py-3"
			data-testid={view.testId}
			role="status"
		>
			<Info class="text-status-info mt-0.5 size-5 shrink-0" aria-hidden={true} />
			<div class="min-w-0 flex-1 space-y-1">
				<p class="text-sm font-semibold">
					{$LL.live.education.tier.schemaVersionMismatch.title()}
				</p>
				<p class="text-muted-foreground text-sm">
					{$LL.live.education.tier.schemaVersionMismatch.body()}
				</p>
			</div>
		</div>
	{/if}
{/if}
