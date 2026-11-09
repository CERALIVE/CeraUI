<script lang="ts">
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '../../app.css';

import PullToRefresh from '$lib/components/custom/pwa/pull-to-refresh.svelte';

let refreshCount = $state(0);
let finishRefresh: (() => void) | undefined;

function refresh(): Promise<void> {
	refreshCount += 1;
	return new Promise<void>((resolve) => {
		finishRefresh = resolve;
	});
}
</script>

<button type="button">Before refresh</button>
<PullToRefresh onRefresh={refresh}>
	<button type="button">After refresh</button>
</PullToRefresh>
<button type="button" onclick={() => finishRefresh?.()}>Finish refresh</button>
<output data-testid="refresh-count">{refreshCount}</output>
