<!--
  ComingSoon.svelte — calm "coming soon" affordance for genuine future features.

  Ground Control treats a roadmap item as INFORMATIONAL, not a warning: a quiet
  muted pill (never the amber/coral state palette) plus a roadmap tooltip that
  explains what's planned. It is deliberately NOT an interactive control — it
  performs no action beyond surfacing the roadmap note on hover/focus, so it can
  never be mistaken for a button that does nothing.

  Every instance MUST carry a `debtId` that points at an OPEN entry in
  docs/TECHNICAL_DEBT.md. The dynamic data-debt-id binding lands in the DOM for
  tests; the static marker the CI gate (scripts/check-tech-debt.mjs) verifies
  lives in a literal call-site comment naming the OPEN register id (TD-NNN).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Clock } from '@lucide/svelte';

import * as Tooltip from '$lib/components/ui/tooltip';
import { cn } from '$lib/utils.js';

interface Props {
	/** OPEN technical-debt id this affordance is bound to (e.g. "TD-pip"). */
	debtId: string;
	/** Roadmap note shown in the tooltip. Defaults to the shared hint copy. */
	hint?: string;
	/** Pill label. Defaults to the shared "Coming soon" copy. */
	label?: string;
	/** Extra classes for the pill. */
	class?: string;
}

let { debtId, hint, label, class: className }: Props = $props();

const pillLabel = $derived(label ?? $LL.live.comingSoon.label());
const roadmap = $derived(hint ?? $LL.live.comingSoon.hint());
</script>

<Tooltip.Provider delayDuration={150}>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<span
					{...props}
					data-debt-id={debtId}
					data-comingsoon={debtId}
					role="note"
					aria-label={`${pillLabel}: ${roadmap}`}
					class={cn(
						'bg-muted text-muted-foreground focus-visible:ring-ring/50 inline-flex w-fit cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
						className,
					)}
				>
					<Clock aria-hidden={true} class="size-3" />
					{pillLabel}
				</span>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content class="max-w-64 text-pretty">
			{roadmap}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
