<script lang="ts">
/**
 * PhoneBitrateControl — the live bitrate control, sized for the screen.
 *
 * From 640 px it is the inline {@link BitrateAdjuster}, as before. On a phone
 * the slider and its two steppers took a full row of the fixed bottom stack,
 * so there the bar shows only the current value as a button beside Stop, and
 * the same adjuster opens in a bottom sheet. One owner of the value either
 * way: every handler is the cockpit's.
 */
import { m } from '@ceraui/i18n/svelte';
import { Gauge } from '@lucide/svelte';
import { tick } from 'svelte';

import { LazyDialogFallback, lazyDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import * as Sheet from '$lib/components/ui/sheet';

import BitrateAdjuster from './BitrateAdjuster.svelte';
import CompactRate from './CompactRate.svelte';

const limitSheet = lazyDialog(() => import('./BitrateLimitSheet.svelte'));
const LimitSheet = $derived(limitSheet.current);

interface Props {
	bitrateDraft: number;
	bitrateLabel: string;
	step: number;
	bitrateMin: number;
	bitrateMax: number;
	sliderMin: number;
	sliderMax: number;
	onStep: (delta: number) => void;
	onSliderChange: (value: number) => void;
	onSliderCommit: (value: number) => void;
	onSliderCancel?: (() => void) | undefined;
}

const { onSliderCancel, ...props }: Props = $props();

let sheetOpen = $state(false);
const query = globalThis.matchMedia?.('(min-width: 640px)');
let wide = $state(query?.matches ?? false);
let trigger: HTMLElement | null = $state(null);
let inline: HTMLDivElement | undefined = $state();

function limitTarget() {
	return (wide ? inline?.querySelector<HTMLElement>('[role="slider"]') : trigger) ?? null;
}

$effect(() => {
	if (sheetOpen) limitSheet.request();
});

$effect(() => {
	if (!query) return;
	const onChange = async () => {
		const hadFocusTrap = sheetOpen && (LimitSheet || limitSheet.pending);
		const focusedLimit = trigger === document.activeElement || inline?.contains(document.activeElement);
		wide = query.matches;
		sheetOpen = false;
		onSliderCancel?.();
		// On resize with the sheet open, its close autofocus waits for the focus trap.
		if (!hadFocusTrap && focusedLimit) {
			await tick();
			limitTarget()?.focus();
		}
	};
	query.addEventListener('change', onChange);
	return () => query.removeEventListener('change', onChange);
});
</script>

<Sheet.Root bind:open={sheetOpen}>
	<div class="shrink-0 sm:min-w-0 sm:flex-1">
		{#if wide}
			<div bind:this={inline}>
				<BitrateAdjuster {...props} />
			</div>
		{:else}
			<Sheet.Trigger>
				{#snippet child({ props: triggerProps })}
					<Button
						{...triggerProps}
						bind:ref={trigger}
						aria-label={m["live.glance.changeBitrate"]({ bitrate: props.bitrateLabel })}
						class="h-auto gap-2 self-stretch px-3 py-4 font-mono text-base"
						variant="outline"
					>
						<Gauge aria-hidden={true} class="size-4" />
						<CompactRate kbps={props.bitrateDraft} />
					</Button>
				{/snippet}
			</Sheet.Trigger>
		{/if}
	</div>
	{#if LimitSheet}
		<LimitSheet
			onCloseAutoFocus={(event: Event) => {
				event.preventDefault();
				if (!sheetOpen) {
					onSliderCancel?.();
					limitTarget()?.focus();
				}
			}}
		>
			{#if !wide}
				<BitrateAdjuster {...props} showLabel={false} />
			{/if}
		</LimitSheet>
	{:else if limitSheet.pending}
		<LazyDialogFallback
			bind:open={sheetOpen}
			failed={limitSheet.failed}
			onRetry={limitSheet.retry}
			returnFocus={limitTarget}
		/>
	{/if}
</Sheet.Root>
