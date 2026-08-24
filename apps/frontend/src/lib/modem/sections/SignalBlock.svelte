<!--
  SignalBlock.svelte — HOW THE RADIO IS, or an honest statement that nothing is
  readable. Leg 2 of the guaranteed minimum baseline: whatever telemetry the
  device published renders, and NOTHING ELSE does.

  ── ABSENCE RENDERS AS ABSENCE ──────────────────────────────────────────────

  A device that published no reading draws NO METER, no dash and no zero. All
  three read as a measurement that was taken and came back at the bottom of the
  scale — which is a different fact, and on a link that is carrying traffic it is
  a false alarm. What renders instead is a sentence.

  ── A NON-READING IS A WORD, NOT A MARK ─────────────────────────────────────

  Every state prints its own word. The glyph and the colour reinforce it and
  never carry it alone, because a kiosk touchscreen cannot hover to reveal a
  tooltip and colour is not readable to every operator.

  ── A CARRIED-OVER READING KEEPS ITS VALUE AND LOSES ITS COLOUR ─────────────

  A device may re-serve its last live reading after a missed cycle so a single
  dropped poll does not blank the row. That is useful and it is not a
  measurement, so it renders muted with the word `Last known` beside it rather
  than in the tier colour — painting the past in the present's colour is the
  quietest way to lie about a radio.

  `provenance` names the INSTRUMENT, never the dialect: this board's own modem
  service, or a reading the device published about itself. Both are rendered by
  the same branch — which is the whole point of this directory.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { SignalHigh, SignalLow, SignalMedium, SignalZero } from '@lucide/svelte';

import { cn } from '$lib/utils';

import type { ModemSignalTier, SignalModel } from './types';

interface Props {
	signal: SignalModel;
	/** Test-id stem. */
	name?: string;
	/** Heading, already localized. Omit for a block whose host already titled it. */
	title?: string;
}

let { signal, name = 'modem-signal', title }: Props = $props();

const TIER_ICON = {
	high: SignalHigh,
	medium: SignalMedium,
	low: SignalLow,
	none: SignalZero,
} satisfies Record<ModemSignalTier, unknown>;

const TIER_COLOR: Record<ModemSignalTier, string> = {
	high: 'text-signal-good',
	medium: 'text-signal-fair',
	low: 'text-signal-weak',
	none: 'text-muted-foreground',
};
</script>

<section class="space-y-1.5" data-testid={name}>
	{#if title}
		<p class="text-muted-foreground text-xs">{title}</p>
	{/if}

	{#if signal.readable}
		{@const TierIcon = TIER_ICON[signal.tier]}
		<div
			class="flex flex-wrap items-center gap-2"
			data-testid={`${name}-reading`}
			data-provenance={signal.provenance}
			data-signal-tier={signal.tier}
			data-stale={signal.stale}
		>
			<span
				class={cn(
					'flex items-center gap-1.5 text-sm',
					signal.stale ? 'text-muted-foreground' : TIER_COLOR[signal.tier],
				)}
			>
				<TierIcon aria-hidden="true" class="size-4 shrink-0" />
				{resolveMessageKey(signal.tierKey)}
			</span>
			{#if signal.stale}
				<span
					class="text-muted-foreground text-xs"
					data-testid={`${name}-stale`}
				>{m['network.routerCellular.signal.stale']()}</span
				>
			{/if}
		</div>
	{:else}
		<p
			class="text-muted-foreground text-xs"
			data-testid={`${name}-unreadable`}
			data-state="unreadable"
			role="status"
		>
			{resolveMessageKey(signal.reasonKey)}
		</p>
	{/if}
</section>
