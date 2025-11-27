<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Binary } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import type { GroupedPipelines } from '$lib/helpers/PipelineHelper';
import { cn } from '$lib/utils';

interface Props {
	groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined;
	properties: {
		inputMode: string | undefined;
		encoder: string | undefined;
		resolution: string | undefined;
		framerate: string | undefined;
		bitrate: number | undefined;
		bitrateOverlay: boolean | undefined;
	};
	formErrors: Record<string, string>;
	isStreaming: boolean;
	onInputModeChange: (value: string) => void;
	onEncoderChange: (value: string) => void;
	onResolutionChange: (value: string) => void;
	onFramerateChange: (value: string) => void;
	onBitrateChange: (value: number) => void;
	onBitrateOverlayChange: (checked: boolean) => void;
	updateMaxBitrate: () => void;
	normalizeValue: (value: number, min: number, max: number, step?: number) => number;
	getSortedResolutions: (resolutions: string[]) => string[];
	getSortedFramerates: (
		framerates: Array<{ extraction: { fps?: string | null } }>,
	) => Array<{ extraction: { fps?: string | null } }>;
}

const {
	groupedPipelines,
	properties,
	formErrors,
	isStreaming,
	onInputModeChange,
	onEncoderChange,
	onResolutionChange,
	onFramerateChange,
	onBitrateChange,
	onBitrateOverlayChange,
	updateMaxBitrate,
	normalizeValue,
	getSortedResolutions,
	getSortedFramerates,
}: Props = $props();

// Local state for all select fields
let localInputMode = $state(properties.inputMode ?? '');
let localEncoder = $state(properties.encoder ?? '');
let localResolution = $state(properties.resolution ?? '');
let localFramerate = $state(properties.framerate ?? '');
let localBitrate = $state(properties.bitrate ?? 5000);

// Track if user has touched each field
let inputModeTouched = $state(false);
let encoderTouched = $state(false);
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
	const newValue = properties.inputMode ?? '';
	const valueChanged = newValue !== localInputMode;
	const shouldSync =
		!inputModeTouched ||
		isComponentInitialMount ||
		properties.inputMode === undefined ||
		valueChanged;
	if (shouldSync && valueChanged) localInputMode = newValue;
});

$effect(() => {
	const newValue = properties.encoder ?? '';
	const valueChanged = newValue !== localEncoder;
	const shouldSync =
		!encoderTouched || isComponentInitialMount || properties.encoder === undefined || valueChanged;
	if (shouldSync && valueChanged) localEncoder = newValue;
});

$effect(() => {
	const newValue = properties.resolution ?? '';
	const valueChanged = newValue !== localResolution;
	const shouldSync =
		!resolutionTouched ||
		isComponentInitialMount ||
		properties.resolution === undefined ||
		valueChanged;
	if (shouldSync && valueChanged) localResolution = newValue;
});

$effect(() => {
	const newValue = properties.framerate ?? '';
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

const hasOnlyOneEncoder = $derived(
	properties.inputMode && groupedPipelines?.[properties.inputMode]
		? Object.keys(groupedPipelines[properties.inputMode]).length === 1
		: false,
);

// Status colors for encoder card (info/blue category)
const statusColors = {
	bg: 'from-blue-500 to-indigo-600',
	border: 'border-blue-500/30',
	icon: 'bg-blue-500',
};
</script>

<Card.Root class={cn('flex h-full flex-col overflow-hidden border', statusColors.border)}>
	<!-- Status Bar -->
	<div class={cn('h-1 bg-gradient-to-r', statusColors.bg)}></div>

	<Card.Header class="p-4 pb-3">
		<div class="flex items-center gap-2.5">
			<div class={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', statusColors.icon)}>
				<Binary class="h-4 w-4 text-white" />
			</div>
			<Card.Title class="text-sm font-semibold">{$LL.settings.encoderSettings()}</Card.Title>
		</div>
	</Card.Header>

	<Card.Content class="flex-1 space-y-4 px-4 pt-0 pb-4">
		<!-- Input Mode Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="inputMode">{$LL.settings.inputMode()}</Label>
			<Select.Root
				disabled={isStreaming}
				onValueChange={(value) => {
					localInputMode = value;
					inputModeTouched = true;
					onInputModeChange(value);
				}}
				type="single"
				value={localInputMode}
			>
				<Select.Trigger id="inputMode" class="w-full">
					{localInputMode ? localInputMode.toUpperCase() : $LL.settings.selectInputMode()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#if groupedPipelines}
							{#each Object.entries(groupedPipelines) as [pipelineKey, _]}
								{@const label = pipelineKey.toUpperCase().split(' ')[0]}
								<Select.Item {label} value={pipelineKey}></Select.Item>
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if formErrors.inputMode}
				<p class="text-destructive text-sm">{formErrors.inputMode}</p>
			{/if}
			{#if properties.inputMode && properties.inputMode.includes('usb')}
				<p class="text-muted-foreground rounded-md bg-blue-500/10 p-2 text-xs">
					ℹ️ {$LL.settings.djiCameraMessage()}
				</p>
			{/if}
		</div>

		<!-- Encoding Format Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="encodingFormat">{$LL.settings.encodingFormat()}</Label
			>
			<Select.Root
				disabled={isStreaming || !properties.inputMode || hasOnlyOneEncoder}
				onValueChange={(value) => {
					localEncoder = value;
					encoderTouched = true;
					onEncoderChange(value);
				}}
				type="single"
				value={localEncoder}
			>
				<Select.Trigger id="encodingFormat" class="w-full">
					{localEncoder ? localEncoder.toUpperCase() : $LL.settings.selectEncodingOutputFormat()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#if properties.inputMode && groupedPipelines?.[properties.inputMode]}
							{#each Object.keys(groupedPipelines[properties.inputMode]) as encoder}
								<Select.Item label={encoder.toUpperCase()} value={encoder}></Select.Item>
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if formErrors.encoder}
				<p class="text-destructive text-sm">{formErrors.encoder}</p>
			{/if}
		</div>

		<!-- Encoding Resolution Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="encodingResolution"
				>{$LL.settings.encodingResolution()}</Label
			>
			<Select.Root
				disabled={isStreaming || !properties.encoder}
				onValueChange={(value) => {
					localResolution = value;
					resolutionTouched = true;
					onResolutionChange(value);
				}}
				type="single"
				value={localResolution}
			>
				<Select.Trigger id="encodingResolution" class="w-full">
					{localResolution ? localResolution : $LL.settings.selectEncodingResolution()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#if properties.encoder && properties.inputMode && groupedPipelines?.[properties.inputMode]?.[properties.encoder]}
							{@const resolutions = getSortedResolutions(
								Object.keys(groupedPipelines[properties.inputMode][properties.encoder]),
							)}
							{#each resolutions as resolution}
								<Select.Item label={resolution} value={resolution}></Select.Item>
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if formErrors.resolution}
				<p class="text-destructive text-sm">{formErrors.resolution}</p>
			{/if}
		</div>

		<!-- Framerate Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="framerate">{$LL.settings.framerate()}</Label>
			<Select.Root
				disabled={isStreaming || !properties.resolution}
				onValueChange={(value) => {
					localFramerate = value;
					framerateTouched = true;
					onFramerateChange(value);
				}}
				type="single"
				value={localFramerate}
			>
				<Select.Trigger id="framerate" class="w-full">
					{localFramerate ? `${localFramerate} ${$LL.units.fps()}` : $LL.settings.selectFramerate()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#if properties.encoder && properties.inputMode && properties.resolution && groupedPipelines?.[properties.inputMode]?.[properties.encoder][properties.resolution]}
							{@const framerates = getSortedFramerates(
								groupedPipelines[properties.inputMode][properties.encoder][properties.resolution],
							)}
							{#each framerates as framerate}
								{#if framerate.extraction.fps}
									<Select.Item label={framerate.extraction.fps} value={framerate.extraction.fps}
									></Select.Item>
								{/if}
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if formErrors.framerate}
				<p class="text-destructive text-sm">{formErrors.framerate}</p>
			{/if}
		</div>

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
