<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Loader2, Play, Square } from '@lucide/svelte';

import * as AlertDialog from '$lib/components/ui/alert-dialog';
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
	/**
	 * Ask before stopping. The Live bar's Stop sits in the thumb zone right
	 * above the mobile dock, where a pocket tap or a missed tap on the dock
	 * lands, so there a tap opens "End the stream?" and only End stream calls
	 * `onStop`. Off for the other hosts, which never show Stop for a live
	 * session.
	 */
	confirmStop?: boolean;
}

const {
	isStreaming,
	canStart,
	optimismState,
	disabledReason,
	onStart,
	onStop,
	confirmStop = false,
}: Props = $props();

let confirmOpen = $state(false);
let keepButton: HTMLButtonElement | null = $state(null);

// Disable button during transient states (starting/stopping).
const isTransient = $derived(optimismState === 'starting' || optimismState === 'stopping');

// The label follows the transient, not just the spinner. A start legitimately
// takes seconds (engine pipeline build + PLAYING, plus the bounded retry
// budget), and a spinner beside the unchanged "Start Stream" reads as a stuck
// button rather than work in progress.
const startLabel = $derived(
	optimismState === 'starting' ? m["live.starting"]() : m["live.startStream"](),
);
const stopLabel = $derived(
	optimismState === 'stopping' ? m["live.stopping"]() : m["live.stopStream"](),
);

function handleStopClick() {
	if (confirmStop) {
		confirmOpen = true;
		return;
	}
	onStop();
}

function confirmEnd() {
	confirmOpen = false;
	onStop();
}

// The question only makes sense while there is a session to end: when the
// stream stops some other way (a helper, the device, a failure) or a stop is
// already in flight, the open question goes away instead of offering to end a
// stream that is no longer there.
$effect(() => {
	if (confirmOpen && (!isStreaming || isTransient)) confirmOpen = false;
});
</script>

<!-- Streaming control — prominent, lime to start, neutral to stop -->
{#if isStreaming || optimismState === 'stopping'}
	<Button
		class="bg-secondary text-secondary-foreground hover:bg-secondary/80 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		aria-haspopup={confirmStop ? 'dialog' : undefined}
		disabled={isTransient}
		onclick={handleStopClick}
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

{#if confirmStop}
	<!-- Centered, so End stream lands well above the Stop button: a double tap
	     on Stop hits the backdrop, which does nothing in an alert dialog. Keep
	     streaming takes the initial focus, so Enter or Space keeps the stream,
	     and comes first in the DOM, so it sits at the bottom of the stacked
	     phone footer. -->
	<AlertDialog.Root bind:open={confirmOpen}>
		<AlertDialog.Content
			class="max-w-sm"
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				keepButton?.focus();
			}}
		>
			<AlertDialog.Header>
				<AlertDialog.Title>{m["live.stopConfirm.title"]()}</AlertDialog.Title>
				<AlertDialog.Description>{m["live.stopConfirm.body"]()}</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel bind:ref={keepButton} class="min-h-[44px]">
					{m["live.stopConfirm.keep"]()}
				</AlertDialog.Cancel>
				<AlertDialog.Action
					class="min-h-[44px]"
					onclick={confirmEnd}
					variant="destructive"
				>
					{m["live.stopConfirm.end"]()}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
{/if}
