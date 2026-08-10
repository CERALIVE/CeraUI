<!--
  EncoderStatus.svelte — ONE encoder widget, two densities, three vocabularies.

  Replaces EncoderCoreLanes, whose two sibling <li> rows read as two unrelated
  readouts and answered no question at a glance: to learn "is this thing
  encoding?" an operator had to read two figures and decide. This adds a
  glanceable headline over the same per-core list, in one frame.

  THE HEADLINE IS A WORD, DERIVED — never a number, never an average.
  `deriveEncoderActivity` (lib/streaming/encoder-load.ts) is a qualitative OR
  over the cores. The two cores' readings are INCOMPARABLE: the vendor 6.1
  kernel reports a real per-core duty cycle via mpp_service, mainline/edge 7.1
  reports only the cores' clock enable-state. So they may be OR-ed ("is anything
  working") but never folded into a magnitude, and the list below is never
  collapsed into the headline — the two cores genuinely differ, and that
  difference is the one observation separating the two drivers.

  TWO CORES ARE A LIST, AND A LIST READS DOWN
  -------------------------------------------
  Both densities now stack the cores as rows of ONE framed module, sharing one
  row skeleton at every size:

      ● rkvenc0   ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░     45.53 %
      ● rkvenc1   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0.00 %

  Side by side, the two figures were flung to opposite ends of the frame and
  their bars started at different x positions — the one comparison this widget
  exists to support (core 0 against core 1) was the one it made hardest. Stacked,
  the bars share a left edge and a scale, the values share a right rail, and the
  two rows are read in a single downward sweep. Inline, the former one-line
  `rkvenc0 45.53% rkvenc1 0.00%` was a flat four-token string that the leading
  pips only partly rescued; it is gone.

  ONE SKELETON, THREE WIDTHS. The rail is `flex-1` over a `min-w-12` floor, so
  ONE declaration serves the panel card, the Device Stats band, and the narrow
  Live-strip cell — width scales it, nothing re-specifies it per surface. This is
  the same rule the `em`-sized pip already follows.

  A RAIL IS A MAGNITUDE; A LEADER IS NOT. A `percent` core has a real denominator
  and draws a proportional rail. An `active` core has none — mainline reports a
  clock enable-bit, not a duty cycle — so it draws a dotted LEADER in that slot
  instead, and an unreadable core does the same. Filling the slot with a full or
  empty track would read as 100 % / 0 %, the exact fabrication C2 bans; leaving it
  empty read as a broken row once the band was wide. See the `leader` snippet.

  WHERE THE VERDICT SITS. In `panel` the verdict joins the title row: a section
  heading and that section's state are one line of thought, and merging them pays
  for the row stacking costs on the 1024x600 kiosk viewport, where the dialog must
  not scroll. In `inline` the host prints the label, so the verdict stands alone —
  and when the host gives the widget a full-width band (`compact`, the Device
  Stats grid tile) the verdict takes a left column from `sm:` up with the core
  module beside it, instead of leaving three quarters of the band empty.

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

  TYPE SPLITS BY KIND, NOT BY SURFACE. The verdict is a WORD, so it is set in the
  UI face in both densities; core ids and readings are identifiers and figures, so
  they stay mono/tabular in both. Inline previously set the verdict in mono while
  panel set it in the UI face — the same widget speaking two typographic
  languages, which is precisely what "they don't feel like the same element"
  described.

  COLOUR IS REINFORCEMENT, NEVER THE SIGNAL. Every state still prints its word
  — headline verdict, `Busy`/`Idle`, `Unavailable` — and the pip is `aria-hidden`
  throughout. An operator on a screen reader, on the e-ink profile, or with a
  colour-vision deficiency loses nothing. All of it is static CSS, so the e-ink
  freeze stills it and the mono token ramp keeps the three tones apart by
  lightness.

  THE THREE PER-CORE VOCABULARIES, in BOTH densities:

    percent     proportional rail  + mono figure
    active      dotted leader      + word (`Busy`/`Idle`), never a digit
    unavailable dotted leader      + word `Unavailable`, never a digit

  `encoder-status.test.ts` pins the no-digit and no-`inline-size` rules for an
  `active` core in both densities.

  DECODE CORES ARE OPT-IN (`showDecoders`), and only Device Health opts in. The
  rows share this widget's renderer because the wire shape is the same union, but
  they are a separate CLAIM under their own heading — and the two inline hosts
  must keep rendering identically whether or not the device reported any.
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
	 * `panel` — Settings → Device Health: card frame, title+verdict header row,
	 * note line.
	 * `inline` — a cell the host has already labelled (the Live cockpit's
	 * telemetry strip, the Device Stats grid): the host's own micro-label serves
	 * as the header, and the precision note is dropped (it belongs in Settings,
	 * not mid-broadcast).
	 */
	density?: 'panel' | 'inline';
	/**
	 * Tighter presentation.
	 *
	 * In `panel` it drops the card chrome (already inside a band). In `inline` it
	 * marks the Device Stats grid-tile host: the headline steps down to that
	 * host's own value scale so a tile does not shout louder than the tiles
	 * beside it, and — because that host spans the grid full-width — the verdict
	 * and the core module sit side by side from `sm:` up rather than leaving the
	 * band's right three quarters empty.
	 */
	compact?: boolean;
	/**
	 * Trailing content for the panel header row. The widget owns the heading now
	 * (its host no longer prints a duplicate one), so anything that used to sit
	 * beside that heading — the engine revision — is passed in here.
	 */
	headerAside?: Snippet;
	/**
	 * Also draw the DECODER cores, when the device reported any.
	 *
	 * OPT-IN, and deliberately so: only Settings → Device Health has the room and
	 * the remit for a second core list. The Device Stats tile and the Live
	 * telemetry strip mount this widget WITHOUT it and must keep rendering
	 * exactly as they did before decode rows existed on the wire — a regression
	 * test pins that their markup is byte-identical whether or not `decodeCores`
	 * is present on the reading.
	 */
	showDecoders?: boolean;
}

const {
	reading,
	density = 'panel',
	compact = false,
	headerAside,
	showDecoders = false,
}: Props = $props();

/** Filled lime, filled muted, hollow ring — in that order of loudness. */
const TONE_PIP: Record<ActivityTone, string> = {
	live: 'bg-primary ring-[0.12em] ring-primary/30',
	quiet: 'bg-muted-foreground/70',
	absent: 'ring-[0.1em] ring-inset ring-muted-foreground/45',
};

/**
 * The shared container for the per-core rows, at EVERY density — a recessed well
 * with one border. `panel` puts only the rows in it (its own card is already the
 * frame the verdict shares); `inline` has no outer card, so the well's header row
 * is where the verdict lives and the two become one object.
 */
const WELL = 'min-w-0 overflow-hidden rounded-lg border';

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

/**
 * The full-width band treatment: only the Device Stats tile hands the widget a
 * whole grid row, and it is the only inline host with room for the precision
 * hint. The Live-strip cell is auto-width mid-broadcast and gets none.
 */
const banded = $derived(inline && compact && instrumented);

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

/**
 * ABSENT is not empty. `decodeCores` is OMITTED when the kernel said nothing
 * about decode — only the vendor 6.1 `mpp_service` interface carries the rows —
 * so no key means no section at all. An empty list is treated the same way: a
 * headed, rowless well would read as "the decoders were measured at nothing".
 *
 * Rows are NEVER filtered: an `unavailable` decoder keeps its slot, because
 * dropping it would silently renumber every decoder after it. The list length is
 * whatever the board printed — there is no fixed decoder count to assume.
 */
const decoderCores = $derived.by(() => {
	if (!showDecoders) return null;
	const rows = reading.decodeCores;
	return rows === undefined || rows.length === 0 ? null : rows;
});
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
		data-marker="pip"
	></span>
{/snippet}

<!--
  The rail slot for a core that published NO denominator. A clock enable-bit and
  an unreadable core have no magnitude, so no track may be drawn — but an empty
  slot is not neutral at width: on the full-width Device Stats band it opened
  ~350px of nothing between `rkvenc0` and `Busy`, which reads as a broken row
  rather than as an absent scale. A dotted leader is the typographic device for
  exactly that (label → value across a gap) and cannot be read as a magnitude: a
  rail is a filled 6px capsule with an `inline-size` fill, this is a hairline
  with neither. Solid rail vs dotted leader is then a glance-level read of which
  kernel answered.
-->
{#snippet leader()}
	<span
		aria-hidden="true"
		class="border-muted-foreground/30 min-w-8 flex-1 self-center border-b border-dotted"
		data-marker="leader"
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

<!--
  The at-a-glance verdict. The pip is decoration; the word carries it, so the
  state is never colour-only. A WORD in the UI face rather than the mono figure
  face inline used to borrow — the readings below are the mono half of this
  widget, and the verdict is not one of them. Static CSS, so the e-ink freeze
  stills it.
-->
{#snippet verdict()}
	<p
		class={cn(
			'flex items-baseline gap-1.5 font-semibold',
			inline ? (compact ? 'text-base' : 'text-lg') : 'text-sm',
		)}
		data-activity={activity}
		data-testid="encoder-status-headline"
		data-tone={headlineTone}
	>
		{@render pip(headlineTone)}
		<span class={cn('min-w-0', TONE_TEXT[headlineTone])}>{headline}</span>
		{#if inline && reading.simulated}
			{@render simulatedPill(true)}
		{/if}
	</p>
{/snippet}

<!--
  The per-core module. ONE framed list, cores stacked as rows split by a single
  rule — they are the two halves of one encoder, so they share a frame rather
  than being spread apart or floated free. List semantics survive the styling: a
  screen reader still hears two discrete cores.

  Every row is `pip · id · rail? · value`, and the value is pushed to a shared
  right rail in all three vocabularies, so the rows align whether or not a
  magnitude exists.
-->
{#snippet coreRows(cores: readonly EncoderCoreReading[], scope: 'encoder' | 'decoder')}
	<ul class="divide-border min-w-0 divide-y text-xs" data-testid="{scope}-core-list">
		{#each cores as core (core.core)}
			{@const tone = coreTone(core)}
			<li
				class="flex min-w-0 items-baseline gap-2.5 px-3 py-2"
				data-core-kind={core.kind}
				data-core-tone={tone}
				data-testid="{scope}-core-{core.core}"
			>
				{@render pip(tone)}
				<!-- The id is the LABEL and the reading is the VALUE, so they must not
				     share a size, a weight and a colour: idle, they collapsed into one
				     flat `rkvenc0 Idle · rkvenc1 Idle` string with nothing marking
				     which half was which. -->
				<span class="text-muted-foreground shrink-0 font-mono text-[11px]">{core.core}</span>

				{#if core.kind === 'percent'}
					<!-- The rail is a SIBLING of the figure on the same baseline row, not
					     a nested wrapper: one flat row keeps every core's pip, id and
					     value on one optical rail. `flex-1` over a `min-w-12` floor is
					     what lets the same declaration stretch across the panel card and
					     still fit the narrow Live-strip cell. -->
					<span
						aria-hidden="true"
						class="bg-secondary relative h-1.5 min-w-12 flex-1 self-center overflow-hidden rounded-full"
						data-marker="rail"
					>
						<span
							class="bg-primary absolute inset-y-0 start-0 rounded-full"
							style="inline-size: {Math.min(100, Math.max(0, core.percent))}%"
						></span>
					</span>
					<span
						class={cn('ms-auto shrink-0 font-mono font-medium tabular-nums', TONE_TEXT[tone])}
						data-testid="{scope}-core-value-{core.core}"
					>
						{core.percent.toFixed(2)}%
					</span>
				{:else if core.kind === 'active'}
					{@render leader()}
					<span
						class={cn('ms-auto min-w-0 truncate font-mono font-medium', TONE_TEXT[tone])}
						data-testid="{scope}-core-value-{core.core}"
					>
						{core.active ? t.cores.busy() : t.cores.idle()}
					</span>
				{:else}
					{@render leader()}
					<!--
						The WORD, not an em-dash. A dash is a mark an operator has to
						decode, and the word it stood for was already sitting in a
						`title` nobody on a touchscreen can hover to read — so this only
						promotes information that was always here.
					-->
					<span
						class={cn('ms-auto min-w-0 truncate font-mono', TONE_TEXT[tone])}
						data-testid="{scope}-core-value-{core.core}"
					>
						{t.unavailable()}
					</span>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

<div
	class={cn(
		'min-w-0',
		inline ? 'space-y-1.5' : 'space-y-2.5',
		!inline && !compact && 'bg-card rounded-xl border p-3.5',
	)}
	data-banded={banded ? 'true' : undefined}
	data-core-count={reading.cores.length}
	data-density={density}
	data-precision={precision}
	data-testid="encoder-cores"
>
	{#if !inline}
		<!-- Title AND verdict on one line: a section heading and that section's
		     state are one thought, and the reclaimed row is what pays for stacking
		     the cores on the 1024x600 kiosk viewport, where this dialog must not
		     scroll. `gap-x-3` rather than `justify-between`, with the chip carrying
		     its own `ms-auto`: the words that belong together pack left and only
		     the chip is pushed out. -->
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<h3 class="text-muted-foreground min-w-0 shrink-0 text-xs font-medium">
				{t.cores.title()}
			</h3>
			{@render verdict()}
			{#if reading.simulated}
				{@render simulatedPill(false)}
			{/if}
			{@render headerAside?.()}
		</div>
	{/if}

	{#if !instrumented}
		<!--
			The collector probed both kernel interfaces and neither answered. The
			core list carries zero information in this state, so it is not drawn.
			This is a hardware/kernel fact about THIS board, not a roadmap item —
			hence the calm register, and no "coming soon" affordance.
			Inline the headline already reads "Not reported" and stops there.
		-->
		{#if inline}
			{@render verdict()}
		{:else}
			<div
				class="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5"
				data-testid="encoder-cores-not-instrumented"
			>
				<p class="text-xs leading-relaxed">{t.cores.notInstrumented()}</p>
			</div>
		{/if}
	{:else if inline}
		<!-- The verdict lives INSIDE the well, as its header, so the summary and
		     the rows it summarises are literally one object. A previous pass put
		     the verdict in a fixed left column with the well floating beside it,
		     and independent review of the deployed board read exactly what that
		     is: "the status looks detached from the rows it summarizes", with a
		     "substantial dead area" in between. Two boxes near each other are not
		     a composition. The well now spans the host's full width, so there is
		     no left column to strand and no gutter to explain. -->
		<div class={cn(WELL, 'bg-muted/40', banded && 'sm:flex sm:items-stretch')}>
			<div
				class={cn(
					'space-y-0.5 border-b px-3 py-2',
					banded && 'sm:w-52 sm:shrink-0 sm:border-b-0 sm:border-e',
				)}
			>
				{@render verdict()}
				{#if banded}
					<!-- The note is dropped mid-broadcast, not in Settings — and the
					     Device Stats tile IS Settings. It names which vocabulary the
					     rows below are speaking, and it gives the verdict cell a second
					     line so the cell earns its height instead of stranding it. -->
					<p
						class="text-muted-foreground/70 hidden text-[11px] leading-snug sm:block"
						data-testid="encoder-cores-precision-hint"
					>
						{precision === 'percent' ? t.cores.percentNote() : t.cores.binaryNote()}
					</p>
				{/if}
			</div>
			<!-- `justify-center` rather than stretched rows: the verdict cell's note
			     wraps to two or three lines depending on which kernel answered, so
			     the two columns are rarely the same natural height. Centering the row
			     GROUP splits that difference evenly instead of pooling it into a void
			     under the last core, and leaves each row's own baseline geometry
			     untouched. -->
			<div class={cn('min-w-0', banded && 'sm:flex sm:flex-1 sm:flex-col sm:justify-center')}>
				{@render coreRows(reading.cores, 'encoder')}
			</div>
		</div>
	{:else}
		<div class={cn(WELL, 'bg-muted/40')}>
			{@render coreRows(reading.cores, 'encoder')}
		</div>
		<p class="text-muted-foreground/80 text-[11px] leading-relaxed" data-testid="encoder-cores-note">
			{precision === 'percent' ? t.cores.percentNote() : t.cores.binaryNote()}
		</p>
	{/if}

	<!-- Decode is a SEPARATE claim, so it gets its own heading and its own well
	     rather than extra rows in the encoder list — and it sits outside the
	     instrumented branch above, because a kernel can report decode while the
	     encode probe finds nothing. Same row renderer, same three vocabularies:
	     the wire shape is identical to the encode rows by construction. -->
	{#if decoderCores !== null}
		<section class="space-y-2.5" data-decoder-count={decoderCores.length} data-testid="decoder-cores">
			<h3 class="text-muted-foreground min-w-0 text-xs font-medium">
				{t.cores.decodeTitle()}
			</h3>
			<div class={cn(WELL, 'bg-muted/40')}>
				{@render coreRows(decoderCores, 'decoder')}
			</div>
		</section>
	{/if}
</div>
