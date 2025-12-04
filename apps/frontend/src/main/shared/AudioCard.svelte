<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AudioCodecsMessage, PipelinesMessage } from '@ceraui/rpc/schemas';
import { Volume } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { cn } from '$lib/utils';

interface Props {
	audioCodecs: AudioCodecsMessage | undefined;
	unparsedPipelines: PipelinesMessage | undefined;
	audioSources: string[];
	notAvailableAudioSource: string | undefined;
	properties: {
		pipeline: keyof PipelinesMessage | undefined;
		audioSource: string | undefined;
		audioCodec: string | undefined;
		audioDelay: number | undefined;
	};
	isStreaming: boolean;
	onAudioSourceChange: (value: string) => void;
	onAudioCodecChange: (value: string) => void;
	onAudioDelayChange: (value: number) => void;
	normalizeValue: (value: number, min: number, max: number, step?: number) => number;
}

const {
	audioCodecs,
	unparsedPipelines,
	audioSources,
	notAvailableAudioSource,
	properties,
	isStreaming,
	onAudioSourceChange,
	onAudioCodecChange,
	onAudioDelayChange,
	normalizeValue,
}: Props = $props();

// Local state for slider binding
let localAudioDelay = $state(properties.audioDelay ?? 0);

// Sync local state with props
$effect(() => {
	const newValue = properties.audioDelay ?? 0;
	localAudioDelay = newValue;
});

const hasAudioSupport = $derived(
	unparsedPipelines &&
		properties.pipeline &&
		(unparsedPipelines[properties.pipeline]?.asrc ||
			unparsedPipelines[properties.pipeline]?.acodec),
);

const hasAudioSource = $derived(
	unparsedPipelines && properties.pipeline && unparsedPipelines[properties.pipeline]?.asrc,
);

const hasAudioCodec = $derived(
	unparsedPipelines && properties.pipeline && unparsedPipelines[properties.pipeline]?.acodec,
);

// Status colors based on audio support
const statusColors = $derived.by(() => {
	if (!properties.pipeline) {
		return {
			bg: 'from-slate-400 to-slate-500',
			border: 'border-slate-300 dark:border-slate-700',
			icon: 'bg-slate-400',
		};
	}
	if (!hasAudioSupport) {
		return {
			bg: 'from-amber-500 to-orange-600',
			border: 'border-amber-500/30',
			icon: 'bg-amber-500',
		};
	}
	return {
		bg: 'from-emerald-500 to-teal-600',
		border: 'border-emerald-500/30',
		icon: 'bg-emerald-500',
	};
});
</script>

<Card.Root class={cn('flex h-full flex-col overflow-hidden border', statusColors.border)}>
	<!-- Status Bar -->
	<div class={cn('h-1 bg-gradient-to-r', statusColors.bg)}></div>

	<Card.Header class="p-4 pb-3">
		<div class="flex items-center gap-2.5">
			<div class={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', statusColors.icon)}>
				<Volume class="h-4 w-4 text-white" />
			</div>
			<Card.Title class="text-sm font-semibold">{$LL.settings.audioSettings()}</Card.Title>
		</div>
	</Card.Header>

	<Card.Content class="flex-1 space-y-4 px-4 pt-0 pb-4">
		{#if !properties.pipeline}
			<!-- Empty State: No pipeline selected -->
			<div class="bg-muted/50 rounded-lg px-4 py-3 text-center">
				<p class="text-muted-foreground text-sm">
					{$LL.settings.selectPipelineFirst()}
				</p>
			</div>
		{:else if !hasAudioSupport}
			<!-- Empty State: No audio support -->
			<div class="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
				<h4 class="text-sm font-medium text-amber-700 dark:text-amber-400">
					{$LL.settings.noAudioSettingSupport()}
				</h4>
				<p class="mt-1 text-xs text-amber-600/80 dark:text-amber-400/70">
					{$LL.settings.selectedPipelineNoAudio()}
				</p>
			</div>
		{:else}
			<!-- Audio Source Selection -->
			{#if hasAudioSource}
				<div class="space-y-2">
					<Label class="text-sm font-medium" for="audioSource">{$LL.settings.audioSource()}</Label>
					<Select.Root
						disabled={isStreaming}
						onValueChange={onAudioSourceChange}
						type="single"
						value={properties.audioSource}
					>
						<Select.Trigger id="audioSource" class="w-full">
							{!properties.audioSource
								? $LL.settings.selectAudioSource()
								: properties.audioSource !== notAvailableAudioSource
									? properties.audioSource
									: `${notAvailableAudioSource} (${$LL.settings.notAvailableAudioSource()})`}
						</Select.Trigger>
						<Select.Content>
							<Select.Group>
								{#if audioSources}
									{#each audioSources as audioSource}
										<Select.Item label={audioSource} value={audioSource}></Select.Item>
									{/each}
								{/if}
								{#if notAvailableAudioSource}
									<Select.Item
										label={`${notAvailableAudioSource} (${$LL.settings.notAvailableAudioSource()})`}
										value={notAvailableAudioSource}
									></Select.Item>
								{/if}
							</Select.Group>
						</Select.Content>
					</Select.Root>
				</div>
			{/if}

			<!-- Audio Codec Selection -->
			{#if hasAudioCodec}
				<div class="space-y-2">
					<Label class="text-sm font-medium" for="audioCodec">{$LL.settings.audioCodec()}</Label>
					<Select.Root
						disabled={isStreaming}
						onValueChange={(value) => onAudioCodecChange(value)}
						type="single"
						value={properties.audioCodec}
					>
						<Select.Trigger id="audioCodec" class="w-full">
							{properties.audioCodec && audioCodecs
								? (Object.entries(audioCodecs).find(
										(acodec) => acodec[0] === properties.audioCodec,
									)?.[1] ?? $LL.settings.selectAudioCodec())
								: $LL.settings.selectAudioCodec()}
						</Select.Trigger>
						<Select.Content>
							<Select.Group>
								{#each Object.entries(audioCodecs || {}) as [codec, label]}
									<Select.Item {label} value={codec}></Select.Item>
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>
				</div>

				<!-- Audio Delay Control -->
				<div class="space-y-3 rounded-lg border bg-slate-50 p-4 dark:bg-slate-900/50">
					<Label class="flex items-center gap-2 text-sm font-medium" for="audioDelay">
						{$LL.settings.audioDelay()}
						<span
							class="rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-400"
						>
							{localAudioDelay}ms
						</span>
					</Label>
					<!-- Custom Center-Zero Slider -->
					<div class="my-4 space-y-2">
						<div class="relative h-6 w-full">
							<!-- Track Background -->
							<div
								class="absolute inset-y-0 top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-slate-200 dark:bg-slate-700"
							></div>

							<!-- Center Line -->
							<div
								class="absolute top-1/2 left-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-slate-400 dark:bg-slate-500"
							></div>

							<!-- Progress Fill -->
							{#if localAudioDelay !== 0}
								{@const safeDelay = isFinite(localAudioDelay) ? localAudioDelay : 0}
								{@const isNegative = safeDelay < 0}
								{@const clampedValue = Math.max(-2000, Math.min(2000, safeDelay))}
								{@const percentage = isFinite(clampedValue)
									? (Math.abs(clampedValue) / 2000) * 50
									: 0}
								{@const safePercentage = isFinite(percentage)
									? Math.max(0, Math.min(50, percentage))
									: 0}
								<div
									style={`${isNegative ? 'right' : 'left'}: 50%; width: ${safePercentage}%;`}
									class={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-200 ${
										isNegative
											? 'bg-gradient-to-r from-amber-500 to-orange-600'
											: 'bg-gradient-to-r from-emerald-500 to-teal-600'
									}`}
								></div>
							{/if}

							<!-- Thumb -->
							<div
								style={`left: ${(() => {
									const safeDelay = isFinite(localAudioDelay) ? localAudioDelay : 0;
									const clampedDelay = Math.max(-2000, Math.min(2000, safeDelay));
									const percentage = ((clampedDelay + 2000) / 4000) * 100;
									return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 50;
								})()}%; transition: left 200ms ease-out, background-color 200ms ease-out;`}
								class={`absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 border-white shadow-md transition-all duration-200 hover:scale-110 dark:border-slate-800 ${
									localAudioDelay === 0
										? 'bg-slate-500 dark:bg-slate-400'
										: localAudioDelay < 0
											? 'bg-amber-500 dark:bg-amber-400'
											: 'bg-emerald-500 dark:bg-emerald-400'
								}`}
							></div>

							<!-- Invisible Input for Interaction -->
							<input
								id="audioDelay"
								class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
								disabled={isStreaming}
								max={2000}
								min={-2000}
								oninput={(e) => {
									const inputValue = parseInt(e.currentTarget.value);
									if (!isNaN(inputValue)) {
										localAudioDelay = inputValue;
										onAudioDelayChange(inputValue);
									}
								}}
								step={1}
								type="range"
								bind:value={localAudioDelay}
							/>
						</div>

						<!-- Value Labels -->
						<div class="text-muted-foreground flex justify-between text-xs">
							<span class="flex items-center gap-1">
								<div class="h-2 w-2 rounded-full bg-amber-500"></div>
								-2000
							</span>
							<span class="text-foreground font-medium">{$LL.settings.perfectSync()}</span>
							<span class="flex items-center gap-1">
								+2000
								<div class="h-2 w-2 rounded-full bg-emerald-500"></div>
							</span>
						</div>
					</div>
					<Input
						id="audioDelayInput"
						class="text-center font-mono"
						disabled={isStreaming}
						onblur={() => {
							const value = normalizeValue(localAudioDelay, -2000, 2000, 5);
							localAudioDelay = value;
							onAudioDelayChange(value);
						}}
						oninput={(e) => {
							const inputValue = parseInt(e.currentTarget.value);
							if (!isNaN(inputValue)) {
								onAudioDelayChange(inputValue);
							}
						}}
						step="5"
						type="number"
						bind:value={localAudioDelay}
					></Input>
					<!-- Additional Help Text -->
					<div class="text-muted-foreground text-center text-xs">
						<span
							>{$LL.settings.audioDelayEarly()} ← 0ms (sync) → {$LL.settings.audioDelayLate()}</span
						>
					</div>
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
