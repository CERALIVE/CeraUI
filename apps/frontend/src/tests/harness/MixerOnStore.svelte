<!--
  The Audio card's mixer as SourceSection and LiveCockpit mount it: every prop
  read from the real subscription store, so a frame the harness ingests reaches
  the strips through the same merge the app uses.
-->
<script lang="ts">
import { getCapabilities, getConfig, getIsStreaming } from '$lib/rpc/subscriptions.svelte';

import AudioMixer from '../../main/live/AudioMixer.svelte';
</script>

<AudioMixer capabilities={getCapabilities()} config={getConfig()} isStreaming={getIsStreaming()} />
