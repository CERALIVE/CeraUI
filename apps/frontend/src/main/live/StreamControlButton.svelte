<script lang="ts">
import { LL } from '@ceraui/i18n/i18n-svelte5';
import { Play, Square, Loader2 } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';

interface Props {
	isStreaming: boolean;
	canStart: boolean;
	optimismState: StreamingOptimismState;
	/** Reason the start control is disabled, surfaced as a hover/`title` hint. */
	disabledReason?: string;
	onStart: () => void;
	onStop: () => void;
}

const { isStreaming, canStart, optimismState, disabledReason, onStart, onStop }: Props =
	$props();

// Disable button during transient states (starting/stopping).
const isTransient = $derived(optimismState === 'starting' || optimismState === 'stopping');

// The label follows the transient, not just the spinner. A start legitimately
// takes seconds (engine pipeline build + PLAYING, plus the bounded retry
// budget), and a spinner beside the unchanged "Start Stream" reads as a stuck
// button rather than work in progress.
const startLabel = $derived(
	optimismState === 'starting' ? $LL.live.starting() : $LL.live.startStream(),
);
const stopLabel = $derived(
	optimismState === 'stopping' ? $LL.live.stopping() : $LL.live.stopStream(),
);
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
		{stopLabel}
	</Button>
{:else}
	<Button
		class="bg-primary text-primary-foreground hover:bg-primary/90 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		disabled={!canStart || isTransient}
		onclick={onStart}
		size="lg"
		title={!canStart || isTransient ? disabledReason : undefined}
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
		{startLabel}
	</Button>
{/if}
