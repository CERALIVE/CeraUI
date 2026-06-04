<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Play, Square } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';

interface Props {
	isStreaming: boolean;
	canStart: boolean;
	onStart: () => void;
	onStop: () => void;
}

const { isStreaming, canStart, onStart, onStop }: Props = $props();
</script>

<!-- Streaming control — prominent, lime to start, neutral to stop -->
{#if isStreaming}
	<Button
		class="bg-secondary text-secondary-foreground hover:bg-secondary/80 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		onclick={onStop}
		size="lg"
		type="button"
	>
		<Square aria-hidden={true} class="h-5 w-5 transition-transform group-hover:scale-110" />
		{$LL.live.stopStream()}
	</Button>
{:else}
	<Button
		class="bg-primary text-primary-foreground hover:bg-primary/90 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		disabled={!canStart}
		onclick={onStart}
		size="lg"
		type="button"
	>
		<Play
			aria-hidden={true}
			class="h-5 w-5 transition-transform group-hover:translate-x-0.5 group-hover:scale-110"
		/>
		{$LL.live.startStream()}
	</Button>
{/if}
