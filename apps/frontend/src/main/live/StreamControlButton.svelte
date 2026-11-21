<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Loader2, Play, Square } from '@lucide/svelte';

import * as AlertDialog from '$lib/components/ui/alert-dialog';
import { Button } from '$lib/components/ui/button';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import { getConfirmedLiveStopEpoch } from '$lib/rpc/subscriptions.svelte';

interface Props {
	isStreaming: boolean;
	canStart: boolean;
	optimismState: StreamingOptimismState;
	/** Reason the start control is disabled, surfaced as a hover/`title` hint. */
	disabledReason?: string;
	onStart: () => void;
	onStop: () => void;
	/** Ask before the Live bar stops a confirmed stream, at every width. */
	confirmStop?: boolean;
	/**
	 * A tap on Start while something blocks it. When set, a blocked Start is
	 * not a dead button: it stays dimmed and `aria-disabled`, and a tap calls
	 * this (the Live bar points at the things to fix) instead of doing nothing.
	 * A start already in flight still disables the button outright.
	 */
}

const {
	isStreaming,
	canStart,
	optimismState,
	disabledReason,
	onStart,
	onStop,
	confirmStop = false,
	onBlockedStart,
}: Props = $props();

let stopIntent = $state<number | null>(null);
let stopButton: HTMLButtonElement | null = $state(null);
let keepButton: HTMLButtonElement | null = $state(null);

// Disable button during transient states (starting/stopping).
const isTransient = $derived(optimismState === 'starting' || optimismState === 'stopping');
const canStop = $derived(isStreaming && !isTransient);
const confirmedStopEpoch = $derived(confirmStop && canStop ? getConfirmedLiveStopEpoch() : undefined);
const confirmOpen = $derived(
	confirmedStopEpoch !== undefined && stopIntent === confirmedStopEpoch,
);

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
	if (!canStop) return;
	if (confirmStop) {
		if (stopIntent === null && confirmedStopEpoch !== undefined) stopIntent = confirmedStopEpoch;
		return;
	}
	onStop();
}

function confirmEnd() {
	const shouldStop = confirmOpen;
	stopIntent = null;
	if (shouldStop) onStop();
}

// Drop invalid intent so it cannot reopen when the control becomes eligible again.
$effect(() => {
	if (stopIntent !== null && !confirmOpen) stopIntent = null;
});

// Blocked but not busy, with somewhere to send the operator: keep the button
// tappable and say it is not ready yet through aria-disabled.
const leadsToFixes = $derived(!canStart && !isTransient && onBlockedStart !== undefined);

function handleStartClick() {
	if (leadsToFixes) {
		onBlockedStart?.();
		return;
	}
	// A blocked or busy Start never starts, even if a click reaches it.
	if (!canStart || isTransient) return;
	onStart();
}
</script>

<!-- Streaming control — prominent, lime to start, neutral to stop -->
{#if isStreaming || optimismState === 'stopping'}
	<Button
		bind:ref={stopButton}
		class="bg-secondary text-secondary-foreground hover:bg-secondary/80 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
		aria-disabled={confirmStop && confirmedStopEpoch === undefined ? true : undefined}
		aria-haspopup={confirmStop ? 'dialog' : undefined}
		data-testid={confirmStop ? 'live-bar-stop' : undefined}
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
		class="bg-primary text-primary-foreground hover:bg-primary/90 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold aria-disabled:opacity-50 [@media(max-height:640px)]:py-3"
		aria-disabled={leadsToFixes ? 'true' : undefined}
		disabled={leadsToFixes ? false : !canStart || isTransient}
		onclick={handleStartClick}
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
	<AlertDialog.Root
		open={confirmOpen}
		onOpenChange={(open) => {
			if (!open) stopIntent = null;
		}}
	>
		<AlertDialog.Content
			class="max-w-sm"
			data-testid="live-stop-confirm"
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				keepButton?.focus();
			}}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				const target = confirmedStopEpoch !== undefined && stopButton?.isConnected
					? stopButton
					: document.getElementById('main-content');
				target?.focus({ preventScroll: true });
			}}
		>
			<AlertDialog.Header>
				<AlertDialog.Title>{m["live.stopConfirm.title"]()}</AlertDialog.Title>
				<AlertDialog.Description>{m["live.stopConfirm.body"]()}</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel
					bind:ref={keepButton}
					class="min-h-[44px]"
					data-testid="live-stop-keep"
				>
					{m["live.stopConfirm.keep"]()}
				</AlertDialog.Cancel>
				<AlertDialog.Action
					class="min-h-[44px]"
					data-testid="live-stop-end"
					onclick={confirmEnd}
					variant="destructive"
				>
					{m["live.stopConfirm.end"]()}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
{/if}
