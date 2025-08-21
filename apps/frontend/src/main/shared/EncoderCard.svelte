<script lang="ts">
import { Binary } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import type { GroupedPipelines } from '$lib/helpers/PipelineHelper';

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
		framerates: Array<{ extraction: { fps?: string } }>,
	) => Array<{ extraction: { fps?: string } }>;
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

// Local state for all select fields to prevent binding undefined values
let localInputMode = $state(properties.inputMode ?? '');
let localEncoder = $state(properties.encoder ?? '');
let localResolution = $state(properties.resolution ?? '');
let localFramerate = $state(properties.framerate ?? '');
let localBitrate = $state(properties.bitrate ?? 5000);

// Track if user has touched each field to prevent auto-syncing user-edited fields
let inputModeTouched = $state(false);
let encoderTouched = $state(false);
let resolutionTouched = $state(false);
let framerateTouched = $state(false);

// Sync FROM properties TO local state when parent provides new data
$effect(() => {
	if (!inputModeTouched) {
		localInputMode = properties.inputMode ?? '';
	}
});

$effect(() => {
	if (!encoderTouched) {
		localEncoder = properties.encoder ?? '';
	}
});

$effect(() => {
	if (!resolutionTouched) {
		localResolution = properties.resolution ?? '';
	}
});

$effect(() => {
	if (!framerateTouched) {
		localFramerate = properties.framerate ?? '';
	}
});

$effect(() => {
	const newValue = properties.bitrate ?? 5000;
	localBitrate = newValue;
});

// No effects watching local state to prevent race conditions
// Parent functions are called directly in onValueChange handlers
</script>

<Card.Root class="group flex h-full flex-col transition-all duration-200 hover:shadow-md">
	<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-4">
		<div class="flex items-center space-x-2">
			<div class="bg-primary/10 rounded-lg p-2">
				<Binary class="text-primary h-4 w-4" />
			</div>
			<Card.Title class="text-base font-semibold">{$_('settings.encoderSettings')}</Card.Title>
		</div>
	</Card.Header>

	<Card.Content class="flex-1 space-y-4">
		<!-- Input Mode Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="inputMode">{$_('settings.inputMode')}</Label>
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
					{localInputMode ? localInputMode.toUpperCase() : $_('settings.selectInputMode')}
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
				<p class="text-muted-foreground bg-accent/50 rounded-md p-2 text-xs">
					ℹ️ {$_('settings.djiCameraMessage')}
				</p>
			{/if}
		</div>

		<!-- Encoding Format Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="encodingFormat">{$_('settings.encodingFormat')}</Label
			>
			<Select.Root
				disabled={isStreaming || !properties.inputMode}
				onValueChange={(value) => {
					localEncoder = value;
					encoderTouched = true;
					onEncoderChange(value);
				}}
				type="single"
				value={localEncoder}
			>
				<Select.Trigger id="encodingFormat" class="w-full">
					{localEncoder ? localEncoder.toUpperCase() : $_('settings.selectEncodingOutputFormat')}
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
				>{$_('settings.encodingResolution')}</Label
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
					{localResolution ? localResolution : $_('settings.selectEncodingResolution')}
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
			<Label class="text-sm font-medium" for="framerate">{$_('settings.framerate')}</Label>
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
					{localFramerate ? `${localFramerate} ${$_('units.fps')}` : $_('settings.selectFramerate')}
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
		<div class="bg-accent/30 space-y-3 rounded-lg p-4">
			<Label class="flex items-center gap-2 text-sm font-medium" for="bitrate">
				{$_('settings.bitrate')}
				<span class="bg-primary/10 text-primary rounded-md px-2 py-1 text-xs">
					{localBitrate || 5000} kbps
				</span>
			</Label>
			<!-- Custom slider with visual progress and thumb -->
			<div class="relative h-6 w-full">
				<!-- Track Background -->
				<div
					class="absolute inset-y-0 top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700"
				></div>
				<!-- Progress Fill -->
				<div
					style={`width: ${(() => {
						const safeBitrate = isFinite(localBitrate) ? localBitrate : 2000;
						const percentage = ((safeBitrate - 2000) / (12000 - 2000)) * 100;
						return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
					})()}%;`}
					class="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-green-400 to-green-500 transition-all duration-200 dark:from-green-500 dark:to-green-600"
				></div>
				<!-- Thumb -->
				<div
					style={`left: ${(() => {
						const safeBitrate = isFinite(localBitrate) ? localBitrate : 2000;
						const percentage = ((safeBitrate - 2000) / (12000 - 2000)) * 100;
						return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
					})()}%;`}
					class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 border-white bg-green-500 shadow-md transition-all duration-200 hover:scale-110 dark:border-gray-800 dark:bg-green-400"
				></div>
				<!-- Invisible Input for Interaction -->
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
						updateMaxBitrate(inputValue);
						onBitrateChange(inputValue); // Call parent to keep everything in sync
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
				<p class="rounded-md bg-amber-50 p-2 text-xs text-amber-600 dark:bg-amber-950/20">
					⚡ {$_('settings.changeBitrateNotice')}
				</p>
			{/if}
		</div>

		<!-- Bitrate Overlay -->
		<div class="hover:bg-accent/50 flex items-center gap-3 rounded-lg border p-3 transition-colors">
			<Checkbox
				id="bitrate-overlay"
				checked={properties.bitrateOverlay}
				onCheckedChange={onBitrateOverlayChange}
			/>
			<Label class="flex-1 cursor-pointer text-sm" for="bitrate-overlay">
				{$_('settings.enableBitrateOverlay')}
			</Label>
		</div>
	</Card.Content>
</Card.Root>
