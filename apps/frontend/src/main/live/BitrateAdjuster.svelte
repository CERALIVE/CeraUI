<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Minus, Plus } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Slider } from '$lib/components/ui/slider';

interface Props {
	/** Live draft value (kbps) shown on the slider and stepper bounds. */
	bitrateDraft: number;
	/** Pre-formatted display string for the current draft (e.g. "6 Mbps"). */
	bitrateLabel: string;
	/** Stepper increment (kbps) — also drives the +/- aria-labels. */
	step: number;
	/** Hard clamp bounds (kbps) — disable steppers at the edges. */
	bitrateMin: number;
	bitrateMax: number;
	/** Practical slider window (kbps). */
	sliderMin: number;
	sliderMax: number;
	onStep: (delta: number) => void;
	onSliderChange: (value: number) => void;
	onSliderCommit: (value: number) => void;
}

const {
	bitrateDraft,
	bitrateLabel,
	step,
	bitrateMin,
	bitrateMax,
	sliderMin,
	sliderMax,
	onStep,
	onSliderChange,
	onSliderCommit,
}: Props = $props();
</script>

<!-- Bitrate hot-adjust: applied live via setBitrate, no stream stop -->
<section
	aria-label={$LL.live.adjustBitrate()}
	class="bg-card space-y-3 rounded-xl border px-5 py-4"
>
	<div class="flex items-center justify-between gap-4">
		<p class="text-sm font-medium">{$LL.live.adjustBitrate()}</p>
		<p
			class="font-mono text-base font-semibold tabular-nums"
			style="color: var(--status-live);"
		>
			{bitrateLabel}
		</p>
	</div>
	<div class="flex items-center gap-3">
		<Button
			aria-label="-{step} {$LL.units.kbps()}"
			class="size-11 shrink-0 rounded-lg"
			disabled={bitrateDraft <= bitrateMin}
			onclick={() => onStep(-step)}
			size="icon"
			variant="outline"
		>
			<Minus aria-hidden={true} class="h-4 w-4" />
		</Button>
		<Slider
			aria-label={$LL.live.adjustBitrate()}
			class="grow"
			max={sliderMax}
			min={sliderMin}
			onValueChange={(v: number) => onSliderChange(v)}
			onValueCommit={(v: number) => onSliderCommit(v)}
			step={step}
			type="single"
			value={bitrateDraft}
		/>
		<Button
			aria-label="+{step} {$LL.units.kbps()}"
			class="size-11 shrink-0 rounded-lg"
			disabled={bitrateDraft >= bitrateMax}
			onclick={() => onStep(step)}
			size="icon"
			variant="outline"
		>
			<Plus aria-hidden={true} class="h-4 w-4" />
		</Button>
	</div>
</section>
