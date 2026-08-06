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

  ONE MARKER, ONE COLOUR RULE, TWO DENSITIES
  ------------------------------------------
  Everything that can be doing work — the headline verdict and every individual
  core — leads with the SAME pip, and takes its colour from the SAME three-tone
  scale (`ActivityTone`):

    live    doing work        filled phosphor-lime pip + haloing ring, lime text
    quiet   a real reading
            of NO work        filled muted pip, ordinary foreground text
    absent  no reading at all hollow ringed pip ("empty socket"), muted text

  The pip is defined entirely in `em`, so ONE definition serves the 18px Live
  strip headline, the 16px Device Stats tile, the 14px panel headline and the
  12px core rows — density changes the size, never the shape. It replaces the
  former lucide `Square`/`SquareCheckBig` glyphs, which read as an unchecked
  HTML checkbox on a surface with nothing to check, and which existed in the
  `panel` density only — so the two densities spoke two icon languages.

  Optical alignment is part of that definition. An empty inline-block sits ON
  the text baseline, putting its centre 0.25em up, while the cap-height centre
  of Space Grotesk / JetBrains Mono is ≈0.35em up. The 0.1em lift closes exactly
  that gap, at every size, with no per-density magic number.

  COLOUR IS REINFORCEMENT, NEVER THE SIGNAL. Every state still prints its word
  — headline verdict, `Busy`/`Idle`, `Unavailable` — and the pip is `aria-hidden`
  throughout. An operator on a screen reader, on the e-ink profile, or with a
  colour-vision deficiency loses nothing. All of it is static CSS, so the e-ink
  freeze stills it and the mono token ramp keeps the three tones apart by
  lightness.

  THE THREE PER-CORE VOCABULARIES, in BOTH densities:

    percent     panel: proportional bar + mono figure   inline: figure only
    active      panel: word                             inline: word
    unavailable panel: word `Unavailable`               inline: word

  Dropping the bar inline is still C2-compliant: the rule bans FABRICATING A
  MAGNITUDE for an `active` core — "a percentage, a half-filled bar, or any
  digit". Inline preserves exactly that, because a `percent` core prints a
  figure with a `%` unit while an `active` core prints a word and NEVER a digit.
  The pip is not a magnitude either: it is binary by construction and carries
  the same claim the word carries. `encoder-status.test.ts` pins the no-digit
  rule in both densities.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Snippet } from 'svelte';
import { FlaskConical } from '@lucide/svelte';

import {
	deriveEncoderActivity,
	type EncoderCoreReading,
	type EncoderLoadReading,
	encoderLoadPrecision,
	isEncoderLoadInstrumented,
} from '$lib/streaming/encoder-load';
import { cn } from '$lib/utils';

/**
 * The one activity vocabulary this widget speaks, at every scale. `quiet` and
 * `absent` are deliberately distinct: a core reporting zero work is a real
 * reading, and must not look like a core that reported nothing at all.
 */
type ActivityTone = 'live' | 'quiet' | 'absent';

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

/** Filled lime, filled muted, hollow ring — in that order of loudness. */
const TONE_PIP: Record<ActivityTone, string> = {
	live: 'bg-primary ring-[0.12em] ring-primary/30',
	quiet: 'bg-muted-foreground/70',
	absent: 'ring-[0.1em] ring-inset ring-muted-foreground/45',
};

const TONE_TEXT: Record<ActivityTone, string> = {
	live: 'text-primary',
	quiet: 'text-foreground',
	absent: 'text-muted-foreground/75',
};

/**
 * A core's tone follows its OWN reading, in its own vocabulary — a measured
 * 0.00 % and a `false` enable-bit are both `quiet` (a real observation of no
 * work), and only an unreadable core is `absent`. No cross-vocabulary
 * comparison happens here: `percent > 0` and `active === true` are read as the
 * same qualitative CLAIM, never as comparable magnitudes.
 */
function coreTone(core: EncoderCoreReading): ActivityTone {
	if (core.kind === 'percent') return core.percent > 0 ? 'live' : 'quiet';
	if (core.kind === 'active') return core.active ? 'live' : 'quiet';
	return 'absent';
}

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

const headlineTone = $derived<ActivityTone>(
	activity === 'encoding' ? 'live' : activity === 'idle' ? 'quiet' : 'absent',
);
</script>

<!--
  The one activity marker. Sized and lifted in `em`, so it inherits its host's
  density instead of being re-specified per surface, and hidden from assistive
  tech because the word beside it is the authoritative statement.
-->
{#snippet pip(tone: ActivityTone)}
	<span
		aria-hidden="true"
		class={cn(
			'inline-block size-[0.5em] shrink-0 -translate-y-[0.1em] rounded-full',
			TONE_PIP[tone],
		)}
	></span>
{/snippet}

{#snippet simulatedPill(micro: boolean)}
	<span
		class={cn(
			'bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 self-center rounded-full font-medium',
			micro ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
		)}
		data-testid="encoder-cores-simulated"
	>
		<FlaskConical aria-hidden={true} class={micro ? 'size-2.5' : 'size-3'} />
		{t.cores.simulated()}
	</span>
{/snippet}

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
		<!-- Title, provenance, then the host's trailing chip. `gap-2` rather than
		     `justify-between`: with the chip carrying its own `ms-auto` the header
		     packs left and only the chip is pushed out, so a two-item header never
		     leaves a void between the words that belong together. -->
		<div class="flex items-center gap-2">
			<h3 class="text-muted-foreground min-w-0 truncate text-xs font-medium">{t.cores.title()}</h3>
			{#if reading.simulated}
				{@render simulatedPill(false)}
			{/if}
			{@render headerAside?.()}
		</div>
	{/if}

	<!-- The at-a-glance verdict. The pip is decoration; the word carries it, so
	     the state is never colour-only. Static CSS, so the e-ink freeze stills it. -->
	<p
		class={cn(
			'flex items-baseline gap-1.5',
			inline
				? cn('font-mono font-semibold', compact ? 'text-base' : 'text-lg')
				: 'text-sm font-semibold',
		)}
		data-activity={activity}
		data-testid="encoder-status-headline"
		data-tone={headlineTone}
	>
		{@render pip(headlineTone)}
		<span class={cn('min-w-0 truncate', TONE_TEXT[headlineTone])}>{headline}</span>
		{#if inline && reading.simulated}
			{@render simulatedPill(true)}
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
		     discrete cores, and the columns are a CSS concern only.

		     `panel` frames the two cores as ONE two-up module split by a single
		     rule, instead of two cells spread to the card's outer edges. They are
		     the two halves of one encoder, and a full-card gap between them read
		     as two unrelated facts. `inline` packs them onto one wrapping line;
		     each entry's leading pip is what keeps two `id value` pairs from
		     reading as one four-token string, so no separate middot idiom is
		     needed. -->
		<ul
			class={cn(
				'min-w-0 text-xs',
				inline
					? 'flex flex-wrap items-baseline gap-x-4 gap-y-1'
					: // Two-up at EVERY width, not just `sm:`. There are exactly two cores
						// and each cell is short, so stacking them buys nothing and costs a
						// row — and that reclaimed row is what pays for the headline.
						'bg-muted/25 grid grid-cols-2 overflow-hidden rounded-lg border [&>li+li]:border-s',
			)}
		>
			{#each reading.cores as core (core.core)}
				{@const tone = coreTone(core)}
				<li
					class={cn('flex min-w-0 items-baseline gap-1.5', !inline && 'px-2.5 py-1.5')}
					data-core-kind={core.kind}
					data-core-tone={tone}
					data-testid="encoder-core-{core.core}"
				>
					{@render pip(tone)}
					<!-- The id is the LABEL and the reading is the VALUE, so they must not
					     share a size, a weight and a colour: idle, they collapsed into one
					     flat `rkvenc0 Idle · rkvenc1 Idle` string with nothing marking
					     which half was which. -->
					<span class="text-muted-foreground shrink-0 font-mono text-[11px]">{core.core}</span>

					{#if core.kind === 'percent' && !inline}
						<!-- The bar is a SIBLING of the figure on the same baseline row, not
						     a nested wrapper: one flat row keeps the cell a single line and
						     keeps every core's pip, id and value on one optical rail. -->
						<span
							aria-hidden="true"
							class="bg-secondary relative h-1.5 min-w-[1.5rem] flex-1 self-center overflow-hidden rounded-full"
						>
							<span
								class="bg-primary absolute inset-y-0 start-0 rounded-full"
								style="inline-size: {Math.min(100, Math.max(0, core.percent))}%"
							></span>
						</span>
					{/if}

					{#if core.kind === 'percent'}
						<span
							class={cn('shrink-0 font-mono font-medium tabular-nums', TONE_TEXT[tone])}
							data-testid="encoder-core-value-{core.core}"
						>
							{core.percent.toFixed(2)}%
						</span>
					{:else if core.kind === 'active'}
						<!-- Binary: the pip and the word. Deliberately no bar and no figure. -->
						<span
							class={cn('min-w-0 truncate font-mono font-medium', TONE_TEXT[tone])}
							data-testid="encoder-core-value-{core.core}"
						>
							{core.active ? t.cores.busy() : t.cores.idle()}
						</span>
					{:else}
						<!--
							The WORD, not an em-dash. A dash is a mark an operator has to
							decode, and the word it stood for was already sitting in a
							`title` nobody on a touchscreen can hover to read — so this only
							promotes information that was always here.
						-->
						<span
							class={cn('min-w-0 truncate font-mono', TONE_TEXT[tone])}
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
