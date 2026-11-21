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

import { Button } from '$lib/components/ui/button';
import * as Sheet from '$lib/components/ui/sheet';

import BitrateAdjuster from './BitrateAdjuster.svelte';
import CompactRate from './CompactRate.svelte';

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
}

const props: Props = $props();

let sheetOpen = $state(false);

// The sheet is the phone's way to the slider. When the screen widens past 640 px
// the inline slider is back, so the sheet closes rather than cover it.
$effect(() => {
	if (typeof window === 'undefined' || !window.matchMedia) return;
	const wide = window.matchMedia('(min-width: 640px)');
	const onChange = () => {
		if (wide.matches) sheetOpen = false;
	};
	wide.addEventListener('change', onChange);
	return () => wide.removeEventListener('change', onChange);
});
</script>

<div class="shrink-0 sm:min-w-0 sm:flex-1">
	<div class="max-sm:hidden">
		<BitrateAdjuster {...props} />
	</div>
	<Button
		aria-label={m["live.glance.changeBitrate"]({ bitrate: props.bitrateLabel })}
		class="h-auto min-h-[44px] gap-2 self-stretch px-3 py-4 font-mono text-base sm:hidden"
		onclick={() => (sheetOpen = true)}
		type="button"
		variant="outline"
	>
		<Gauge aria-hidden={true} class="size-4" />
		<CompactRate value={props.bitrateLabel} />
	</Button>
</div>

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content
		class="gap-0 px-4 pt-2 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]"
		data-touch-region
		side="bottom"
	>
		<Sheet.Header class="px-0">
			<Sheet.Title>{m["live.adjustBitrate"]()}</Sheet.Title>
		</Sheet.Header>
		<BitrateAdjuster {...props} showLabel={false} />
	</Sheet.Content>
</Sheet.Root>
