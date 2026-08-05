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

  The staleness watchdog keys on CONTENT, not arrival — see
  `audio-meter-liveness.ts` for why a frame landing is not evidence the audio path
  behind it is alive. Its clock is a single deadline re-armed on each genuinely
  new reading, not a poll, so staleness lands exactly `AUDIO_METER_STALE_MS` after
  the content last moved. The same module owns the selection gate that retires a
  reading the moment the operator picks a different audio source, so the previous
  device's bars never render under the new pick's label.
-->
<script lang="ts">
import { untrack } from 'svelte';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import {
	AUDIO_METER_STALE_MS,
	INITIAL_METER_FRESHNESS,
	INITIAL_METER_SELECTION_GATE,
	isLevelSuperseded,
	type MeterFreshness,
	type MeterSelectionGate,
	trackMeterFreshness,
	trackMeterSelection,
} from '$lib/components/preview/audio-meter-liveness';
import { getAudioLevel, getConfig } from '$lib/rpc/subscriptions.svelte';
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
const dead = $derived(pending || stale || superseded || level?.unavailable === true);
</script>

<div
	class={cn('min-w-0', className)}
	data-pending={pending ? 'true' : 'false'}
	data-stale={stale ? 'true' : 'false'}
	data-superseded={superseded ? 'true' : 'false'}
	data-testid="live-audio-meter"
>
	<AudioLevelMeter
		class="space-y-1"
		peakDb={dead ? [] : (level?.peak_db ?? [])}
		reason={pending || stale || superseded ? undefined : level?.reason}
		rmsDb={dead ? [] : (level?.rms_db ?? [])}
		unavailable={dead}
	/>
</div>
