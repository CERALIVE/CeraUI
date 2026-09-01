<!--
  LiveAudioMeter.svelte — the always-mounted, compact audio level meter
  (device-quality-wave2 Todo 22; inlined into the audio surfaces 2026-07).

  Reads the main-WS `audio-level` broadcast via `getAudioLevel()` (fed by the backend
  audio-meter bridge from the engine's always-on sidecar) and renders the shared
  `AudioLevelMeter` as a slim strip. Mounted INLINE beside the thing it meters —
  SourceSection's audio-source block while idle, LiveSummaryStrip's audio line while
  streaming — never as its own full-width page section.

  It ALWAYS renders. `AudioLevelMeter` already owns the active/silent/unavailable
  states, so a missing feed shows the meter's own "unavailable" copy rather than
  vanishing: an operator must be able to tell "the meter says nothing is coming in"
  apart from "the meter isn't here".

  It also NAMES the device the bars belong to (`meteredAudioLabel`), so a reading
  is never an anonymous set of numbers. It therefore reads three subscription
  getters — `getAudioLevel`, `getConfig` and `getStatus` — and a test that mounts
  it (directly or through SourceSection/LiveSummaryStrip) must mock all three.

  The staleness watchdog keys on CONTENT, not arrival — see
  `audio-meter-liveness.ts` for why a frame landing is not evidence the audio path
  behind it is alive. Its clock is a single deadline re-armed on each genuinely
  new reading, not a poll, so staleness lands exactly `AUDIO_METER_STALE_MS` after
  the content last moved. The same module owns the selection gate that retires a
  reading the moment the operator picks a different audio source, so the previous
  device's bars never render under the new pick's label.

  A gap BETWEEN TWO LIVE READINGS is held for `METER_UNAVAILABLE_DISPLAY_GRACE_MS`
  before it may draw the band. That is a display rule and only a display rule: the
  band is honest and it is also instantaneous, so one dropped frame used to flash
  the full "Meter unavailable" treatment for a single paint — which reads as the
  meter blinking, and a blink is indistinguishable from the real thing. Four
  properties are load-bearing. It holds the reading already ON SCREEN (blanking
  the bars is a different flash, not the absence of one). It arms ONE deadline per
  gap, so a feed that keeps publishing `unavailable` at the engine cadence still
  bands rather than debouncing forever. Recovery is NOT graced — the next live
  frame restores the bars in that same paint. And `pending`/`stale`/`superseded`
  plus the two STATED reasons (`mode_none`, `embedded_audio`) are exempt, so
  nothing an operator or a source positively asserted is ever delayed.
-->
<script lang="ts">
import { untrack } from 'svelte';

import type { AudioLevelMessage } from '@ceraui/rpc/schemas';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import {
	AUDIO_METER_STALE_MS,
	INITIAL_METER_FRESHNESS,
	INITIAL_METER_SELECTION_GATE,
	isLevelSuperseded,
	isTransientMeterGap,
	METER_UNAVAILABLE_DISPLAY_GRACE_MS,
	type MeterFreshness,
	type MeterSelectionGate,
	trackMeterFreshness,
	trackMeterSelection,
} from '$lib/components/preview/audio-meter-liveness';
import { resolveMessageKey } from '@ceraui/i18n/svelte';

import { getAudioLevel, getConfig, getStatus } from '$lib/rpc/subscriptions.svelte';
import { meteredAudioLabel, resolveAudioSourceList } from '$lib/streaming/sourceSummary';
import { cn } from '$lib/utils';

interface Props {
	class?: string;
}

const { class: className = undefined }: Props = $props();

const level = $derived(getAudioLevel());
const selection = $derived(getConfig()?.asrc);

let freshness = $state<MeterFreshness>(INITIAL_METER_FRESHNESS);
let selectionGate = $state<MeterSelectionGate>(INITIAL_METER_SELECTION_GATE);
let stale = $state(false);

// Advance the liveness clock on new INFORMATION, never on arrival. Every
// broadcast is a fresh object, so stamping here on each event proved only that
// frames were flowing — which stays true for a device that keeps clocking ALSA
// buffers of frozen content, and for the engine replaying its cached last
// observation to a reconnecting subscriber. `trackMeterFreshness` returns the
// previous state unchanged for a repeat, so the assignment is then a no-op.
$effect(() => {
	const current = level;
	untrack(() => {
		freshness = trackMeterFreshness(freshness, current, Date.now());
	});
});

// Drop the reading the operator's PREVIOUS pick produced, without waiting for
// the backend's confirming broadcast — see `trackMeterSelection`.
$effect(() => {
	const current = level;
	const currentSelection = selection;
	untrack(() => {
		selectionGate = trackMeterSelection(selectionGate, currentSelection, current);
	});
});

// ONE deadline, re-armed on each genuinely new reading — never a background
// poll. `freshness` moves only when the content does, so this effect re-runs
// exactly when the meter says something new: the pending timer is cleared and a
// fresh one armed. A timer that survives to fire IS "nothing new for
// AUDIO_METER_STALE_MS", so staleness resolves at the deadline itself rather
// than at the next tick after it, and an idle meter costs no work at all.
$effect(() => {
	// `0` is "no frame has ever landed" — the distinct `pending` state, which
	// has no deadline to arm because there is no reading to age out.
	if (freshness.lastChangedAt === 0) return;
	stale = false;
	const id = setTimeout(() => {
		stale = true;
	}, AUDIO_METER_STALE_MS);
	return () => clearTimeout(id);
});

// No frame has EVER arrived (engine down, bridge not up yet). Distinct from
// `stale`, and from an engine-sent `unavailable` marker that carries a reason.
const pending = $derived(level === undefined);
const superseded = $derived(isLevelSuperseded(selectionGate, level));

// An engine gap the display grace MAY hold over — see `isTransientMeterGap`.
const transientGap = $derived(isTransientMeterGap(level));

// Everything that draws the band with no delay at all. `pending`, `stale` and
// `superseded` are untouched by the grace on purpose (each answers a question
// this window has no evidence about), and so is a STATED `unavailable` reason.
const hardDead = $derived(
	pending || stale || superseded || (level?.unavailable === true && !transientGap),
);

// The reading currently on screen, and therefore the one a transient gap holds
// over. A gap with nothing behind it — the first frame this meter ever sees, or
// one arriving onto an already-dead meter — has nothing to suppress, so it bands
// immediately. Cleared by `hardDead` so a genuinely retired reading can never be
// resurrected by a later gap.
let heldLevel = $state<AudioLevelMessage | undefined>(undefined);
let graceElapsed = $state(false);

$effect(() => {
	const current = level;
	const live = !hardDead && !transientGap && current !== undefined;
	const retired = hardDead;
	untrack(() => {
		if (live) heldLevel = current;
		else if (retired) heldLevel = undefined;
	});
});

// ONE deadline per gap, armed when the gap begins and never re-armed by the
// repeat frames inside it — so a feed that keeps publishing `unavailable` at the
// engine cadence still bands at the deadline instead of debouncing forever.
$effect(() => {
	if (!(transientGap && !hardDead && heldLevel !== undefined)) {
		graceElapsed = false;
		return;
	}
	graceElapsed = false;
	const id = setTimeout(() => {
		graceElapsed = true;
	}, METER_UNAVAILABLE_DISPLAY_GRACE_MS);
	return () => clearTimeout(id);
});

// Inside the window the gap is invisible: the meter keeps rendering the reading
// it already had. Recovery is NOT graced — the very next live frame drops
// `transientGap` and the real reading is back in that same paint.
const gapHeld = $derived(
	transientGap && !hardDead && heldLevel !== undefined && !graceElapsed,
);

const dead = $derived(hardDead || (transientGap && !gapHeld));
const displayLevel = $derived(gapHeld ? heldLevel : level);

// WHICH device these bars belong to. Only shown while they are real: a retired,
// stale or unavailable reading has no device to name, and labelling one would be
// the same "bars under the wrong name" the selection gate exists to prevent.
const meteredDevice = $derived(
	dead
		? undefined
		: meteredAudioLabel(
				displayLevel?.source?.identity,
				resolveAudioSourceList(getStatus()?.audio_sources, getStatus()?.asrcs ?? []),
				resolveMessageKey,
			),
);
</script>

<div
	class={cn('min-w-0', className)}
	data-gap-held={gapHeld ? 'true' : 'false'}
	data-pending={pending ? 'true' : 'false'}
	data-stale={stale ? 'true' : 'false'}
	data-superseded={superseded ? 'true' : 'false'}
	data-testid="live-audio-meter"
>
	<AudioLevelMeter
		class="space-y-1"
		peakDb={dead ? [] : (displayLevel?.peak_db ?? [])}
		reason={pending || stale || superseded ? undefined : displayLevel?.reason}
		rmsDb={dead ? [] : (displayLevel?.rms_db ?? [])}
		unavailable={dead}
	/>
	{#if meteredDevice !== undefined}
		<p
			class="text-muted-foreground truncate pt-0.5 font-mono text-[11px] tracking-wide"
			data-testid="live-audio-meter-device"
		>
			{meteredDevice}
		</p>
	{/if}
</div>
