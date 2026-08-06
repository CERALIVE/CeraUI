<!--
  EncoderStatus.svelte — ONE encoder widget, two densities, three vocabularies.

  Replaces EncoderCoreLanes, whose two sibling <li> rows read as two unrelated
  readouts and answered no question at a glance: to learn "is this thing
  encoding?" an operator had to read two figures and decide. This adds a
  glanceable headline over the same per-core grid, in one frame.

  THE HEADLINE IS A WORD, DERIVED — never a number, never an average.
  `deriveEncoderActivity` (lib/streaming/encoder-load.ts) is a qualitative OR
  over the cores. The two cores' readings are INCOMPARABLE: the vendor 6.1
  kernel reports a real per-core duty cycle via mpp_service, mainline/edge 7.1
  reports only the cores' clock enable-state. So they may be OR-ed ("is anything
  working") but never folded into a magnitude, and the grid below is never
  collapsed into the headline — the two cores genuinely differ, and that
  difference is the one observation separating the two drivers.

  THE THREE PER-CORE VOCABULARIES, in BOTH densities:

    percent     panel: proportional bar + mono figure   inline: figure only
    active      panel: filled/hollow SQUARE + word      inline: word only
    unavailable panel: `—` labelled Unavailable         inline: `—`

  Dropping the bar/square inline is still C2-compliant: the rule bans
  FABRICATING A MAGNITUDE for an `active` core — "a percentage, a half-filled
  bar, or any digit". Inline preserves exactly that, because a `percent` core
  prints a figure with a `%` unit while an `active` core prints a word and NEVER
  a digit. The bar was the panel's reinforcement of the distinction, not its
  carrier. `encoder-status.test.ts` pins the no-digit rule in both densities.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Snippet } from 'svelte';
import { FlaskConical, Square, SquareCheckBig } from '@lucide/svelte';

import {
	deriveEncoderActivity,
	type EncoderLoadReading,
	encoderLoadPrecision,
	isEncoderLoadInstrumented,
} from '$lib/streaming/encoder-load';
import { cn } from '$lib/utils';

interface Props {
	reading: EncoderLoadReading;
	/**
	 * `panel` — Settings → Device Health: card frame, header, note line.
	 * `inline` — a cell inside the Live cockpit's telemetry strip: the strip's
	 * own uppercase micro-label serves as the header, and the precision note is
	 * dropped (it belongs in Settings, not mid-broadcast).
	 */
	density?: 'panel' | 'inline';
	/**
	 * Tighter presentation. In `panel` it drops the card chrome (already inside a
	 * band); in `inline` it steps the headline down to the host's own value
	 * scale, so a grid tile does not shout louder than the tiles beside it.
	 */
	compact?: boolean;
	/**
	 * Trailing content for the panel header row. The widget owns the heading now
	 * (its host no longer prints a duplicate one), so anything that used to sit
	 * beside that heading — the engine revision — is passed in here.
	 */
	headerAside?: Snippet;
}

const { reading, density = 'panel', compact = false, headerAside }: Props = $props();

const t = $derived($LL.settings.deviceHealth);
const instrumented = $derived(isEncoderLoadInstrumented(reading));
const precision = $derived(encoderLoadPrecision(reading));
const activity = $derived(deriveEncoderActivity(reading));
const inline = $derived(density === 'inline');

const headline = $derived(
	activity === 'encoding'
		? t.cores.headlineEncoding()
		: activity === 'idle'
			? t.cores.headlineIdle()
			: t.cores.headlineUnreported(),
);
</script>

<div
	class={cn(
		'min-w-0',
		inline ? 'space-y-1' : 'space-y-2.5',
		!inline && !compact && 'bg-card rounded-xl border p-3.5',
	)}
	data-core-count={reading.cores.length}
	data-density={density}
	data-precision={precision}
	data-testid="encoder-cores"
>
	{#if !inline}
		<div class="flex items-center justify-between gap-3">
			<h3 class="text-muted-foreground min-w-0 truncate text-xs font-medium">{t.cores.title()}</h3>
			{@render headerAside?.()}
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
	{/if}

	<!-- The at-a-glance verdict. The dot is decoration; the word carries it, so
	     the state is never colour-only. Static CSS, so the e-ink freeze stills it. -->
	<p
		class={cn(
			'flex items-center gap-2',
			inline ? cn('font-mono font-semibold', compact ? 'text-base' : 'text-lg') : 'text-sm',
		)}
		data-activity={activity}
		data-testid="encoder-status-headline"
	>
		<span
			aria-hidden="true"
			class={cn(
				'inline-block size-2 shrink-0 rounded-full',
				activity === 'encoding' ? 'bg-primary' : 'border-muted-foreground/50 border',
			)}
		></span>
		<span class={cn('truncate', inline ? '' : 'text-foreground font-semibold')}>{headline}</span>
		{#if inline && reading.simulated}
			<span
				class="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
				data-testid="encoder-cores-simulated"
			>
				<FlaskConical aria-hidden={true} class="size-2.5" />
				{t.cores.simulated()}
			</span>
		{/if}
	</p>

	{#if !instrumented}
		<!--
			The collector probed both kernel interfaces and neither answered. The
			core grid carries zero information in this state, so it is not drawn.
			This is a hardware/kernel fact about THIS board, not a roadmap item —
			hence the calm register, and no "coming soon" affordance.
			Inline the headline already reads "Not reported" and stops there.
		-->
		{#if !inline}
			<div
				class="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5"
				data-testid="encoder-cores-not-instrumented"
			>
				<p class="text-xs leading-relaxed">{t.cores.notInstrumented()}</p>
			</div>
		{/if}
	{:else}
		<!-- List semantics survive the grid: a screen reader still hears two
		     discrete cores, and the columns are a CSS concern only. -->
		<ul
			class={cn(
				'min-w-0',
				inline
					? 'flex flex-wrap gap-x-3 gap-y-0.5'
					: // Two-up at EVERY width, not just `sm:`. There are exactly two cores
						// and each cell is short, so stacking them buys nothing and costs a
						// row — and that reclaimed row is what pays for the headline.
						'grid grid-cols-2 gap-x-4 gap-y-2',
			)}
		>
			{#each reading.cores as core (core.core)}
				<li
					class={cn(
						'min-w-0',
						inline
							? // A middot between cores, so two `id value` pairs on one wrapped
								// line never read as one four-token string. Same separator idiom
								// the strip's own bitrate qualifiers use.
								"flex items-baseline gap-1.5 [&:not(:first-child)]:before:text-muted-foreground/40 [&:not(:first-child)]:before:content-['·']"
							: 'space-y-0.5',
					)}
					data-core-kind={core.kind}
					data-testid="encoder-core-{core.core}"
				>
					<span class="text-muted-foreground shrink-0 font-mono text-[11px]">{core.core}</span>

					{#if core.kind === 'percent' && inline}
						<span
							class="text-foreground shrink-0 font-mono text-xs tabular-nums"
							data-testid="encoder-core-value-{core.core}"
						>
							{core.percent.toFixed(2)}%
						</span>
					{:else if core.kind === 'percent'}
						<!-- Bar and figure share ONE line: the id above them already names
						     the core, so a third line per cell is pure height. -->
						<span class="flex min-w-0 items-center gap-2">
							<span
								aria-hidden="true"
								class="bg-secondary relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
							>
								<span
									class="bg-primary absolute inset-y-0 start-0 rounded-full"
									style="inline-size: {Math.min(100, Math.max(0, core.percent))}%"
								></span>
							</span>
							<span
								class="text-foreground shrink-0 font-mono text-xs tabular-nums"
								data-testid="encoder-core-value-{core.core}"
							>
								{core.percent.toFixed(2)}%
							</span>
						</span>
					{:else if core.kind === 'active'}
						<!-- Binary: a mark and a word. Deliberately no bar and no figure. -->
						<span
							class={cn(
								'inline-flex min-w-0 items-center gap-1.5 font-mono text-xs',
								core.active ? 'text-primary' : 'text-muted-foreground',
							)}
							data-testid="encoder-core-value-{core.core}"
						>
							{#if !inline}
								{#if core.active}
									<SquareCheckBig aria-hidden={true} class="size-3.5 shrink-0" />
								{:else}
									<Square aria-hidden={true} class="size-3.5 shrink-0" />
								{/if}
							{/if}
							<span class="truncate">{core.active ? t.cores.busy() : t.cores.idle()}</span>
						</span>
					{:else}
						<!--
							The WORD, not an em-dash. A dash is a mark an operator has to
							decode, and the word it stood for was already sitting in a
							`title` nobody on a touchscreen can hover to read — so this only
							promotes information that was always here.
						-->
						<span
							class={cn('text-muted-foreground/70 text-xs', inline ? '' : 'block')}
							data-testid="encoder-core-value-{core.core}"
						>
							{t.unavailable()}
						</span>
					{/if}
				</li>
			{/each}
		</ul>

		{#if !inline}
			<p
				class="text-muted-foreground/80 text-[11px] leading-relaxed"
				data-testid="encoder-cores-note"
			>
				{precision === 'percent' ? t.cores.percentNote() : t.cores.binaryNote()}
			</p>
		{/if}
	{/if}
</div>
