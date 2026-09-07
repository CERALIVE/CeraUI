<script lang="ts">
import { createStreamingStateManager } from '../StreamingStateManager.svelte';

const manager = createStreamingStateManager();
const state = $derived(manager.getState());
const sameReference = $derived(state === manager.getState());
</script>

<div data-testid="streaming-state-consumer" data-same-reference={sameReference}>
	{state.audioSources.join(',')}
</div>
