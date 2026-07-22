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

const level = $derived(getAudioLevel());
</script>

{#if level !== undefined}
	<section
		class="border-border/60 bg-card/40 rounded-lg border p-3"
		data-testid="live-audio-meter"
		aria-label={$LL.live.preview.audioLabel()}
	>
		<p class="text-muted-foreground mb-2 font-mono text-[10px] uppercase tracking-wider">
			{$LL.live.preview.audioLabel()}
		</p>
		<AudioLevelMeter
			rmsDb={level.rms_db ?? []}
			peakDb={level.peak_db ?? []}
			unavailable={level.unavailable === true}
			reason={level.reason}
		/>
	</section>
{/if}
