<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Play, Square, Loader2 } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';

interface Props {
	isStreaming: boolean;
	canStart: boolean;
	optimismState: StreamingOptimismState;
	onStart: () => void;
	onStop: () => void;
}

const { isStreaming, canStart, optimismState, onStart, onStop }: Props = $props();

// Disable button during transient states (starting/stopping).
const isTransient = $derived(optimismState === 'starting' || optimismState === 'stopping');
</script>

<!-- Streaming control — prominent, lime to start, neutral to stop -->
{#if isStreaming || optimismState === 'stopping'}
	<Button
		class="bg-secondary text-secondary-foreground hover:bg-secondary/80 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		disabled={isTransient}
		onclick={onStop}
		size="lg"
		type="button"
	>
		{#if optimismState === 'stopping'}
			<Loader2 aria-hidden={true} class="h-5 w-5 animate-spin motion-reduce:animate-none" />
		{:else}
			<Square aria-hidden={true} class="h-5 w-5 transition-transform group-hover:scale-110" />
		{/if}
		{$LL.live.stopStream()}
	</Button>
{:else}
	<Button
		class="bg-primary text-primary-foreground hover:bg-primary/90 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		disabled={!canStart || isTransient}
		onclick={onStart}
		size="lg"
		type="button"
	>
		{#if optimismState === 'starting'}
			<Loader2 aria-hidden={true} class="h-5 w-5 animate-spin motion-reduce:animate-none" />
		{:else}
			<Play
				aria-hidden={true}
				class="h-5 w-5 transition-transform group-hover:translate-x-0.5 group-hover:scale-110"
			/>
		{/if}
		{$LL.live.startStream()}
	</Button>
{/if}
