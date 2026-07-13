<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import { Label } from '$lib/components/ui/label';

interface Props {
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
}

let { value, min, max, step, onChange }: Props = $props();

function clamp(candidate: number): number {
	return Math.max(min, Math.min(max, candidate));
}

function percent(candidate: number): number {
	const result = ((clamp(candidate) - min) / (max - min)) * 100;
	return Number.isFinite(result) ? Math.max(0, Math.min(100, result)) : 50;
}

const zeroPercent = $derived(percent(0));
const thumbPercent = $derived(percent(value));
const fillStart = $derived(Math.min(zeroPercent, thumbPercent));
const fillWidth = $derived(Math.abs(thumbPercent - zeroPercent));
</script>

<div class="bg-muted/40 space-y-3 rounded-lg border p-4">
	<Label class="flex items-center justify-between gap-2 text-sm font-medium" for="audioDelay">
		<span>{$LL.settings.audioDelay()}</span>
		<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">{value}ms</span>
	</Label>
	<div class="my-3">
		<div class="relative h-6 w-full rounded-lg [&:has(input:focus-visible)]:ring-2 [&:has(input:focus-visible)]:ring-ring [&:has(input:focus-visible)]:ring-offset-2">
			<div class="bg-muted absolute inset-x-0 inset-y-0 top-1/2 h-2 -translate-y-1/2 rounded-full"></div>
			<div style={`inset-inline-start: ${zeroPercent}%;`} class="bg-muted-foreground/40 absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2"></div>
			{#if fillWidth > 0}
				<div style={`inset-inline-start: ${fillStart}%; width: ${fillWidth}%;`} class={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-200 ${value < 0 ? 'bg-muted-foreground' : 'bg-primary'}`}></div>
			{/if}
			<div style={`inset-inline-start: ${thumbPercent}%; transition: inset-inline-start 200ms ease-out, background-color 200ms ease-out;`} class={`border-background absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md transition-all duration-200 rtl:translate-x-1/2 ${value <= 0 ? 'bg-muted-foreground' : 'bg-primary'} cursor-pointer hover:scale-110`}></div>
			<input id="audioDelay" class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" {max} {min} oninput={(event) => {
				const candidate = Number.parseInt(event.currentTarget.value, 10);
				if (!Number.isNaN(candidate)) onChange(clamp(candidate));
			}} {step} type="range" {value} />
		</div>
		<div class="text-muted-foreground mt-2 flex items-center justify-between text-xs">
			<span class="flex items-center gap-1"><span class="bg-muted-foreground h-2 w-2 rounded-full"></span>{min}</span>
			<span class="text-foreground font-medium">{$LL.settings.perfectSync()}</span>
			<span class="flex items-center gap-1">+{max}<span class="bg-primary h-2 w-2 rounded-full"></span></span>
		</div>
	</div>
	<p class="text-muted-foreground text-center text-xs">{$LL.settings.audioDelayEarly()} ← 0ms → {$LL.settings.audioDelayLate()}</p>
</div>
