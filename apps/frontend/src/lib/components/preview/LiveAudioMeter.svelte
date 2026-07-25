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
-->
<script lang="ts">
import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import { getAudioLevel } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	class?: string;
}

const { class: className = undefined }: Props = $props();

// Staleness deadline: the engine sidecar emits at ≤10Hz (≥100ms). If no frame
// arrives for this long the source has stalled (cerastream killed/crashed, the
// bridge dropped) — fall to `unavailable`, NEVER frozen stale bars showing a
// last-known level. Comfortably above the cadence so a normal gap never trips it.
const STALE_MS = 2000;
const TICK_MS = 500;

const level = $derived(getAudioLevel());

let lastAt = $state(0);
let now = $state(0);

// Record arrival time on every new frame (each broadcast is a fresh object, so the
// `level` reference changes per event — the effect re-runs and stamps lastAt).
$effect(() => {
	if (level !== undefined) lastAt = Date.now();
});

// Independent clock so staleness resolves even while no frame arrives.
$effect(() => {
	now = Date.now();
	const id = setInterval(() => {
		now = Date.now();
	}, TICK_MS);
	return () => clearInterval(id);
});

const stale = $derived(level !== undefined && lastAt > 0 && now - lastAt > STALE_MS);
// No frame has EVER arrived (engine down, bridge not up yet). Distinct from
// `stale`, and from an engine-sent `unavailable` marker that carries a reason.
const pending = $derived(level === undefined);
const dead = $derived(pending || stale || level?.unavailable === true);
</script>

<div
	class={cn('min-w-0', className)}
	data-pending={pending ? 'true' : 'false'}
	data-stale={stale ? 'true' : 'false'}
	data-testid="live-audio-meter"
>
	<AudioLevelMeter
		class="space-y-1"
		peakDb={dead ? [] : (level?.peak_db ?? [])}
		reason={pending || stale ? undefined : level?.reason}
		rmsDb={dead ? [] : (level?.rms_db ?? [])}
		unavailable={dead}
	/>
</div>
