<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Binary, Cpu } from '@lucide/svelte';
import type { Pipelines, Pipeline, Resolution, Framerate, HardwareType } from '@ceraui/rpc/schemas';

import * as Card from '$lib/components/ui/card';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { getSourceLabel, getResolutionLabel, getFramerateLabel, getHardwareLabel } from '$lib/helpers/PipelineHelper';
import { cn } from '$lib/utils';

// Available resolutions and framerates
const RESOLUTIONS: Resolution[] = ["480p", "720p", "1080p", "1440p", "2160p"];
const FRAMERATES: Framerate[] = [25, 29.97, 30, 50, 59.94, 60];

interface Props {
	pipelines: Pipelines | undefined;
	hardware: HardwareType | undefined;
	properties: {
		source: string | undefined;
		resolution: Resolution | undefined;
		framerate: Framerate | undefined;
		bitrate: number | undefined;
		bitrateOverlay: boolean | undefined;
	};
	formErrors: Record<string, string>;
	isStreaming: boolean;
	onSourceChange: (value: string) => void;
	onResolutionChange: (value: Resolution) => void;
	onFramerateChange: (value: Framerate) => void;
	onBitrateChange: (value: number) => void;
	onBitrateOverlayChange: (checked: boolean) => void;
	updateMaxBitrate: () => void;
	normalizeValue: (value: number, min: number, max: number, step?: number) => number;
}

const {
	pipelines,
	hardware,
	properties,
	formErrors,
	isStreaming,
	onSourceChange,
	onResolutionChange,
	onFramerateChange,
	onBitrateChange,
	onBitrateOverlayChange,
	updateMaxBitrate,
	normalizeValue,
}: Props = $props();

// Translation-aware label getters
const t = (key: string) => {
	// Use $LL to get translation by key path
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key; // Return key if translation not found
		}
	}
	return typeof result === 'function' ? result() : key;
};

const getSourceLabelTranslated = (source: string) => getSourceLabel(source, t);
const getHardwareLabelTranslated = (hw: string) => getHardwareLabel(hw, t);

// Local state for all select fields
let localSource = $state('');
let localResolution = $state<Resolution>('1080p');
let localFramerate = $state<Framerate>(30);
let localBitrate = $state(5000);

// Track if user has touched each field
let sourceTouched = $state(false);
let resolutionTouched = $state(false);
let framerateTouched = $state(false);

// Track initial mount for forced sync during restoration
let isComponentInitialMount = $state(true);

$effect(() => {
	if (isComponentInitialMount) {
		setTimeout(() => {
			isComponentInitialMount = false;
		}, 200);
	}
});

// Sync FROM properties TO local state
$effect(() => {
	const newValue = properties.source ?? '';
	const valueChanged = newValue !== localSource;
	const shouldSync =
		!sourceTouched ||
		isComponentInitialMount ||
		properties.source === undefined ||
		valueChanged;
	if (shouldSync && valueChanged) localSource = newValue;
});

$effect(() => {
	const newValue = properties.resolution ?? '1080p';
	const valueChanged = newValue !== localResolution;
	const shouldSync =
		!resolutionTouched ||
		isComponentInitialMount ||
		properties.resolution === undefined ||
		valueChanged;
	if (shouldSync && valueChanged) localResolution = newValue;
});

$effect(() => {
	const newValue = properties.framerate ?? 30;
	const valueChanged = newValue !== localFramerate;
	const shouldSync =
		!framerateTouched ||
		isComponentInitialMount ||
		properties.framerate === undefined ||
		valueChanged;
	if (shouldSync && valueChanged) localFramerate = newValue;
});

$effect(() => {
	const newValue = properties.bitrate ?? 5000;
	localBitrate = newValue;
});

// Get the selected pipeline
const selectedPipeline = $derived<Pipeline | undefined>(
	localSource && pipelines ? pipelines[localSource] : undefined
);

// Status colors for encoder card (info/blue category)
const statusColors = {
	bg: 'from-blue-500 to-indigo-600',
	border: 'border-blue-500/30',
	icon: 'bg-blue-500',
};
</script>

<Card.Root
	class={cn('flex h-full flex-col gap-0 overflow-hidden border py-0', statusColors.border)}
>
	<!-- Status Bar -->
	<div class={cn('h-1 bg-gradient-to-r', statusColors.bg)}></div>

	<Card.Header class="p-4 pb-3">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2.5">
				<div class={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', statusColors.icon)}>
					<Binary class="h-4 w-4 text-white" />
				</div>
				<Card.Title class="text-sm font-semibold">{$LL.settings.encoderSettings()}</Card.Title>
			</div>
			{#if hardware}
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Cpu class="h-3.5 w-3.5" />
					<span>{getHardwareLabelTranslated(hardware)}</span>
				</div>
			{/if}
		</div>
	</Card.Header>

	<Card.Content class="flex-1 space-y-4 px-4 pt-0 pb-4">
		<!-- Video Source Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="videoSource">{$LL.settings.inputMode()}</Label>
			<Select.Root
				disabled={isStreaming}
				onValueChange={(value) => {
					localSource = value;
					sourceTouched = true;
					onSourceChange(value);
				}}
				type="single"
				value={localSource}
			>
			<Select.Trigger id="videoSource" class="w-full">
				{localSource ? getSourceLabelTranslated(localSource) : $LL.settings.selectInputMode()}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#if pipelines}
						{#each Object.entries(pipelines) as [sourceId, pipeline]}
							<Select.Item value={sourceId}>
								<div class="flex flex-col py-1">
									<span class="font-medium">{getSourceLabelTranslated(sourceId)}</span>
									<span class="text-xs text-muted-foreground">{pipeline.description}</span>
								</div>
							</Select.Item>
						{/each}
					{/if}
				</Select.Group>
			</Select.Content>
			</Select.Root>
			{#if formErrors.source}
				<p class="text-destructive text-sm">{formErrors.source}</p>
			{/if}
		</div>

		<!-- Resolution Selection (if supported) -->
		{#if selectedPipeline?.supportsResolutionOverride}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="resolution">{$LL.settings.encodingResolution()}</Label>
				<Select.Root
					disabled={isStreaming}
					onValueChange={(value) => {
						localResolution = value as Resolution;
						resolutionTouched = true;
						onResolutionChange(value as Resolution);
					}}
					type="single"
					value={localResolution}
				>
					<Select.Trigger id="resolution" class="w-full">
						{localResolution ? getResolutionLabel(localResolution) : $LL.settings.selectEncodingResolution()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each RESOLUTIONS as resolution}
								<Select.Item label={getResolutionLabel(resolution)} value={resolution}></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
				{#if formErrors.resolution}
					<p class="text-destructive text-sm">{formErrors.resolution}</p>
				{/if}
			</div>
		{/if}

		<!-- Framerate Selection (if supported) -->
		{#if selectedPipeline?.supportsFramerateOverride}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="framerate">{$LL.settings.framerate()}</Label>
				<Select.Root
					disabled={isStreaming}
					onValueChange={(value) => {
						const numValue = parseFloat(value) as Framerate;
						localFramerate = numValue;
						framerateTouched = true;
						onFramerateChange(numValue);
					}}
					type="single"
					value={String(localFramerate)}
				>
					<Select.Trigger id="framerate" class="w-full">
						{localFramerate ? getFramerateLabel(localFramerate) : $LL.settings.selectFramerate()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each FRAMERATES as framerate}
								<Select.Item label={getFramerateLabel(framerate)} value={String(framerate)}></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
				{#if formErrors.framerate}
					<p class="text-destructive text-sm">{formErrors.framerate}</p>
				{/if}
			</div>
		{/if}

		<!-- Bitrate Control -->
		<div class="space-y-3 rounded-lg border bg-slate-50 p-4 dark:bg-slate-900/50">
			<Label class="flex items-center gap-2 text-sm font-medium" for="bitrate">
				{$LL.settings.bitrate()}
				<span class="rounded-md bg-blue-500/10 px-2 py-1 text-xs text-blue-700 dark:text-blue-400">
					{localBitrate || 5000} kbps
				</span>
			</Label>
			<!-- Custom slider -->
			<div class="relative h-6 w-full">
				<!-- Track Background -->
				<div
					class="absolute inset-y-0 top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-slate-200 dark:bg-slate-700"
				></div>
				<!-- Progress Fill -->
				<div
					style={`width: ${(() => {
						const safeBitrate = isFinite(localBitrate) ? localBitrate : 2000;
						const percentage = ((safeBitrate - 2000) / (12000 - 2000)) * 100;
						return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
					})()}%;`}
					class="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-200"
				></div>
				<!-- Thumb -->
				<div
					style={`left: ${(() => {
						const safeBitrate = isFinite(localBitrate) ? localBitrate : 2000;
						const percentage = ((safeBitrate - 2000) / (12000 - 2000)) * 100;
						return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
					})()}%;`}
					class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 border-white bg-blue-500 shadow-md transition-all duration-200 hover:scale-110 dark:border-slate-800"
				></div>
				<!-- Invisible Input -->
				<input
					id="bitrate"
					class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					max={12000}
					min={2000}
					oninput={(e) => {
						const inputValue = parseInt(e.currentTarget.value);
						if (!isNaN(inputValue)) {
							localBitrate = inputValue;
							onBitrateChange(inputValue);
							updateMaxBitrate();
						}
					}}
					step={50}
					type="range"
					bind:value={localBitrate}
				/>
			</div>
			<Input
				class="text-center font-mono"
				max={12000}
				min={2000}
				onblur={() => {
					const value = normalizeValue(localBitrate, 2000, 12000, 50);
					if (value !== localBitrate) {
						localBitrate = value;
						onBitrateChange(value);
						updateMaxBitrate();
					}
				}}
				oninput={(e) => {
					const inputValue = parseInt(e.currentTarget.value);
					if (!isNaN(inputValue)) {
						localBitrate = inputValue;
						updateMaxBitrate();
						onBitrateChange(inputValue);
					}
				}}
				step="50"
				type="number"
				value={localBitrate || 5000}
			></Input>
			{#if formErrors.bitrate}
				<p class="text-destructive text-sm">{formErrors.bitrate}</p>
			{/if}
			{#if isStreaming}
				<p class="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
					⚡ {$LL.settings.changeBitrateNotice()}
				</p>
			{/if}
		</div>

		<!-- Bitrate Overlay -->
		<div
			class="flex items-center gap-3 rounded-lg border bg-slate-50 p-3 transition-colors hover:bg-slate-100 dark:bg-slate-900/50 dark:hover:bg-slate-800/50"
		>
			<Checkbox
				id="bitrate-overlay"
				checked={properties.bitrateOverlay}
				onCheckedChange={onBitrateOverlayChange}
			/>
			<Label class="flex-1 cursor-pointer text-sm" for="bitrate-overlay">
				{$LL.settings.enableBitrateOverlay()}
			</Label>
		</div>
	</Card.Content>
</Card.Root>
