<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Loader2, Play, Square } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

interface Props {
	isStreaming: boolean;
	onStart: () => void;
	onStop: () => void;
	disabled?: boolean;
	/** Transition flags — disable the control and show a spinner. */
	starting?: boolean;
	stopping?: boolean;
	variant?: 'sticky' | 'floating';
}

const {
	isStreaming,
	onStart,
	onStop,
	disabled = false,
	starting = false,
	stopping = false,
	variant = 'floating',
}: Props = $props();

// Lock interaction during any in-flight start/stop transition.
const busy = $derived(starting || stopping);
const startDisabled = $derived(disabled || busy);
const stopDisabled = $derived(busy);

const handleStart = () => {
	if (!startDisabled) {
		onStart();
	}
};

// Stop semantics are owned by the parent's onStop handler (legacy stop path
// lives there). We never call the stop RPC directly here.
const handleStop = () => {
	if (!stopDisabled) {
		onStop();
	}
};
</script>

{#snippet startButton(extraClass: string)}
	<Button
		class={cn(
			'group min-h-[44px] w-full font-semibold transition-colors duration-200',
			'bg-primary text-primary-foreground hover:bg-primary/90',
			startDisabled && 'cursor-not-allowed opacity-60',
			extraClass,
		)}
		disabled={startDisabled}
		onclick={handleStart}
		size="lg"
		type="button"
	>
		<span class="flex items-center justify-center gap-3">
			{#if starting}
				<Loader2 aria-hidden={true} class="h-5 w-5 animate-spin" />
				<span>{$LL.live.starting()}</span>
			{:else}
				<Play
					aria-hidden={true}
					class="h-5 w-5 transition-transform group-hover:translate-x-0.5 group-hover:scale-110"
				/>
				<span>{$LL.live.startStream()}</span>
			{/if}
		</span>
	</Button>
{/snippet}

{#snippet stopButton(extraClass: string)}
	<Button
		class={cn(
			'group min-h-[44px] w-full font-semibold transition-colors duration-200',
			'bg-secondary text-secondary-foreground hover:bg-secondary/80',
			stopDisabled && 'cursor-not-allowed opacity-60',
			extraClass,
		)}
		disabled={stopDisabled}
		onclick={handleStop}
		size="lg"
		type="button"
	>
		<span class="flex items-center justify-center gap-3">
			{#if stopping}
				<Loader2 aria-hidden={true} class="h-5 w-5 animate-spin" />
				<span>{$LL.live.stopping()}</span>
			{:else}
				<span class="relative flex">
					<Square aria-hidden={true} class="h-5 w-5 transition-transform group-hover:scale-110" />
					<!-- Live indicator: the stream is active, so the neutral stop carries a lime pulse. -->
					<span
						class="absolute -end-1 -top-1 h-2 w-2 rounded-full motion-safe:animate-pulse"
						style="background-color: var(--status-live);"
					></span>
				</span>
				<span>{$LL.live.stopStream()}</span>
			{/if}
		</span>
	</Button>
{/snippet}

{#if variant === 'floating'}
	<!-- Floating action dock at the bottom of the viewport -->
	<div class="fixed inset-x-0 bottom-0 z-50 p-4 pb-6 sm:pb-4">
		<div class="mx-auto max-w-md">
			<div class="bg-card rounded-2xl border p-3">
				{#if isStreaming}
					{@render stopButton('rounded-xl py-6 text-lg')}
				{:else}
					{@render startButton('rounded-xl py-6 text-lg')}
					{#if disabled && !busy}
						<p class="text-muted-foreground mt-2 text-center text-sm">
							{$LL.settings.completeRequiredFields()}
						</p>
					{/if}
				{/if}
			</div>
		</div>
	</div>

	<!-- Spacer so content is never hidden behind the floating dock -->
	<div class="h-28 sm:h-24"></div>
{:else}
	<!-- Sticky header variant -->
	<div class="bg-background/95 sticky top-0 z-10 border-b p-6 pb-4 backdrop-blur-sm">
		<div class="mx-auto max-w-4xl">
			{#if isStreaming}
				{@render stopButton('')}
			{:else}
				{@render startButton('')}
				{#if disabled && !busy}
					<p class="text-muted-foreground mt-2 text-center text-sm">
						{$LL.settings.completeRequiredFields()}
					</p>
				{/if}
			{/if}
		</div>
	</div>
{/if}
