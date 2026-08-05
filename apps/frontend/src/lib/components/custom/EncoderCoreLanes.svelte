<!--
  EncoderCoreLanes.svelte — per-core encoder load, in the honest state it is in.

  The RK3588's two VEPU580 cores are reported completely differently by the two
  kernels CeraLive ships (see `lib/streaming/encoder-load.ts` for the live
  measurement table), so a core is `percent`, `active`, or `unavailable` — and
  the three get three DIFFERENT visual vocabularies, on purpose:

    percent  → a proportional bar + a mono figure. 0-100 is a real denominator
               the driver produced, so a bar is an honest picture of it.
    active   → a filled / hollow SQUARE and a word. No bar, no figure, no "%".
               Drawing busy/idle as a half-filled bar would fabricate a
               magnitude the kernel never measured.
    unavailable → the inherited `—` placeholder, labelled Unavailable.

  The shape difference is the point: an operator must be able to tell a measured
  number from an on/off bit at a glance, without reading a caption.

  Per-CORE, never aggregated — the two cores genuinely differ (vendor kept core 1
  idle under load; mainline dispatched to both), and an average would hide the
  one observation that separates the two drivers.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { FlaskConical, Square, SquareCheckBig } from '@lucide/svelte';

import {
	encoderLoadPrecision,
	type EncoderLoadReading,
	isEncoderLoadInstrumented,
} from '$lib/streaming/encoder-load';
import { cn } from '$lib/utils';

interface Props {
	reading: EncoderLoadReading;
}

let { reading }: Props = $props();

const t = $derived($LL.settings.deviceHealth);
const instrumented = $derived(isEncoderLoadInstrumented(reading));
const precision = $derived(encoderLoadPrecision(reading));
</script>

<div class="space-y-2" data-testid="encoder-cores" data-precision={precision}>
	<div class="flex items-center justify-between gap-3">
		<span class="text-muted-foreground text-xs font-medium">{t.cores.title()}</span>
		{#if reading.simulated}
			<span
				class="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
				data-testid="encoder-cores-simulated"
			>
				<FlaskConical aria-hidden={true} class="size-3" />
				{t.cores.simulated()}
			</span>
		{/if}
	</div>

	{#if !instrumented}
		<!--
			The collector probed both kernel interfaces and neither answered, so the
			panel says so rather than drawing a shape. This is a hardware/kernel fact
			about THIS board, not a roadmap item — hence the calm informational
			register, and no "coming soon" affordance.
		-->
		<div
			class="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5"
			data-testid="encoder-cores-not-instrumented"
		>
			<p class="text-xs leading-relaxed">{t.cores.notInstrumented()}</p>
		</div>
	{:else}
		<ul class="space-y-1.5">
			{#each reading.cores as core (core.core)}
				<li
					class="flex items-center gap-3"
					data-testid="encoder-core-{core.core}"
					data-core-kind={core.kind}
				>
					<span class="text-foreground w-20 shrink-0 font-mono text-xs">{core.core}</span>

					{#if core.kind === 'percent'}
						<span
							class="bg-secondary relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
							aria-hidden="true"
						>
							<span
								class="bg-primary absolute inset-y-0 start-0 rounded-full"
								style="inline-size: {Math.min(100, Math.max(0, core.percent))}%"
							></span>
						</span>
						<span
							class="text-foreground w-16 shrink-0 text-end font-mono text-xs tabular-nums"
							data-testid="encoder-core-value-{core.core}"
						>
							{core.percent.toFixed(2)}%
						</span>
					{:else if core.kind === 'active'}
						<!-- Binary: a mark and a word. Deliberately no bar and no figure. -->
						<span
							class={cn(
								'inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs',
								core.active ? 'text-primary' : 'text-muted-foreground',
							)}
							data-testid="encoder-core-value-{core.core}"
						>
							{#if core.active}
								<SquareCheckBig aria-hidden={true} class="size-3.5 shrink-0" />
							{:else}
								<Square aria-hidden={true} class="size-3.5 shrink-0" />
							{/if}
							<span class="font-mono">{core.active ? t.cores.busy() : t.cores.idle()}</span>
						</span>
					{:else}
						<span
							class="text-muted-foreground/60 min-w-0 flex-1 font-mono text-xs"
							data-testid="encoder-core-value-{core.core}"
							title={t.unavailable()}
							aria-label={t.unavailable()}
						>
							&mdash;
						</span>
					{/if}
				</li>
			{/each}
		</ul>

		<p class="text-muted-foreground/80 text-[11px] leading-relaxed" data-testid="encoder-cores-note">
			{precision === 'percent' ? t.cores.percentNote() : t.cores.binaryNote()}
		</p>
	{/if}
</div>
