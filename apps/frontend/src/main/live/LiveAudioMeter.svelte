<!--
  LiveAudioMeter.svelte — the always-visible audio level meter (device-quality-wave2
  Todo 22).

  Reads the main-WS `audio-level` broadcast via `getAudioLevel()` (fed by the backend
  audio-meter bridge from the engine's always-on sidecar) and renders the shared
  `AudioLevelMeter`. Mounted in LiveView OUTSIDE the preview, so the bars move while
  IDLE with no preview open (a clap near the mic reacts) and continue across
  start/stop. The in-preview meter (PreviewCanvas) keeps its own preview-socket path.

  Before the first event arrives it renders nothing (no fake silence). An
  `unavailable` marker from the engine renders the meter's unavailable state.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import { getAudioLevel } from '$lib/rpc/subscriptions.svelte';

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
</script>

{#if level !== undefined}
	<section
		class="border-border/60 bg-card/40 rounded-lg border p-3"
		data-testid="live-audio-meter"
		data-stale={stale ? 'true' : 'false'}
		aria-label={$LL.live.preview.audioLabel()}
	>
		<p class="text-muted-foreground mb-2 font-mono text-[10px] uppercase tracking-wider">
			{$LL.live.preview.audioLabel()}
		</p>
		<AudioLevelMeter
			rmsDb={stale ? [] : (level.rms_db ?? [])}
			peakDb={stale ? [] : (level.peak_db ?? [])}
			unavailable={stale || level.unavailable === true}
			reason={stale ? undefined : level.reason}
		/>
	</section>
{/if}
