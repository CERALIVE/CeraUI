<script lang="ts">
import { LL, getTranslationByKey } from '@ceraui/i18n/svelte';
import { toast } from 'svelte-sonner';

import {
	autoSelectNextOption,
	resetDependentSelections,
} from '$lib/components/streaming/StreamingAutoSelection';
import {
	buildStreamingConfig,
	startStreamingWithConfig,
} from '$lib/components/streaming/StreamingConfigService';
// Import new modular components
import { createStreamingStateManager } from '$lib/components/streaming/StreamingStateManager';
import {
	getSortedResolutions,
	normalizeValue,
	updateMaxBitrate,
} from '$lib/components/streaming/StreamingUtils';
import { validateStreamingForm } from '$lib/components/streaming/StreamingValidation';
import { parsePipelineName } from '$lib/helpers/PipelineHelper';
import type { AudioCodecs } from '$lib/helpers/SystemHelper';
import { stopStreaming } from '$lib/helpers/SystemHelper';
import type { PipelinesMessage } from '$lib/types/socket-messages';
import AudioCard from '$main/shared/AudioCard.svelte';
import EncoderCard from '$main/shared/EncoderCard.svelte';
import ServerCard from '$main/shared/ServerCard.svelte';
import StreamingControls from '$main/shared/StreamingControls.svelte';

type Properties = {
	inputMode: string | undefined;
	encoder: string | undefined;
	resolution: string | undefined;
	framerate: string | undefined;
	pipeline: keyof PipelinesMessage | undefined;
	bitrate: number | undefined;
	bitrateOverlay: boolean | undefined;
	audioSource: string | undefined;
	audioCodec: AudioCodecs | undefined;
	audioDelay: number | undefined;
	relayServer: string | undefined;
	relayAccount: string | undefined;
	srtlaServerAddress: string | undefined;
	srtlaServerPort: number | undefined;
	srtStreamId: string | undefined;
	srtLatency: number | undefined;
};

// for selected preload
type InitialSelectedProperties = Pick<
	Properties,
	'audioSource' | 'pipeline' | 'audioCodec' | 'audioDelay' | 'bitrate' | 'bitrateOverlay'
>;

// Create state manager
const stateManager = createStreamingStateManager();

// Extract stores for reactive access
const { savedConfigStore } = stateManager;
const { relayMessageStore } = stateManager;
const { unparsedPipelinesStore } = stateManager;
const { audioCodecsStore } = stateManager;
const { groupedPipelinesStore } = stateManager;
const { isStreamingStore } = stateManager;
const { audioSourcesStore } = stateManager;
const { notAvailableAudioSourceStore } = stateManager;

let properties: Properties = $state({
	bitrate: undefined,
	bitrateOverlay: false,
	audioCodec: undefined,
	audioDelay: 0,
	audioSource: undefined,
	encoder: undefined,
	framerate: undefined,
	inputMode: undefined,
	pipeline: undefined,
	relayAccount: undefined,
	relayServer: undefined,
	resolution: undefined,
	srtlaServerAddress: undefined,
	srtlaServerPort: undefined,
	srtLatency: undefined,
	srtStreamId: undefined,
});

const initialSelectedProperties: InitialSelectedProperties = $state({
	audioDelay: undefined,
	audioSource: undefined,
	pipeline: undefined,
	audioCodec: undefined,
	bitrate: undefined,
	bitrateOverlay: false,
});

// Form state
let formErrors = $state<Record<string, string>>({});

// Flags to prevent effects from overriding user selections
let isProgrammaticChange = $state(false);

// Track which specific fields user has touched (per-field interaction tracking)
let srtlaAddressTouched = $state(false);
let srtlaPortTouched = $state(false);
let srtStreamIdTouched = $state(false);
let srtLatencyTouched = $state(false);

// Track encoder-related user interactions (separate from ServerCard)
let userHasInteracted = $state(false);

// Track initial restoration phase to prevent premature userHasInteracted setting
let isInitialMount = $state(true);

// Allow initial restoration to complete before tracking user interactions
$effect(() => {
	if (isInitialMount && $savedConfigStore && properties.pipeline) {
		// Wait for initial state restoration to complete
		setTimeout(() => {
			isInitialMount = false;
		}, 100);
	}
});

// React to saved config changes and initialize properties
$effect(() => {
	if ($savedConfigStore) {
		const config = $savedConfigStore;

		if (properties.srtLatency === undefined) {
			properties.srtLatency = config.srt_latency ?? 2000;
		}

		// Only restore fields that user hasn't specifically touched
		if (!srtlaPortTouched && properties.srtlaServerPort === undefined && config.srtla_port) {
			properties.srtlaServerPort = config.srtla_port;
		}

		if (!srtStreamIdTouched && !properties.srtStreamId && config.srt_streamid) {
			properties.srtStreamId = config.srt_streamid;
		}

		if (!srtlaAddressTouched && !properties.srtlaServerAddress && config.srtla_addr) {
			properties.srtlaServerAddress = config.srtla_addr;
		}

		if (initialSelectedProperties.audioDelay === undefined) {
			properties.audioDelay = initialSelectedProperties.audioDelay = config.delay ?? 0;
		}
		if (!initialSelectedProperties.pipeline) {
			properties.pipeline = initialSelectedProperties.pipeline = config.pipeline;
		}
		if (!initialSelectedProperties.bitrate) {
			properties.bitrate = initialSelectedProperties.bitrate = config?.max_br ?? 5000;
		}

		if (!initialSelectedProperties.bitrateOverlay) {
			properties.bitrateOverlay = initialSelectedProperties.bitrateOverlay =
				config?.bitrate_overlay ?? false;
		}
		if (!initialSelectedProperties.audioSource) {
			properties.audioSource = initialSelectedProperties.audioSource = config?.asrc ?? '';
		}
		if (!initialSelectedProperties.audioCodec) {
			properties.audioCodec = initialSelectedProperties.audioCodec = config.acodec as AudioCodecs;

			// If no audio codec in config but pipeline supports audio, default to aac
			if (!config.acodec && config.pipeline && $unparsedPipelinesStore && $audioCodecsStore) {
				const pipelineData = $unparsedPipelinesStore[config.pipeline];
				if (pipelineData?.acodec) {
					const aacCodec = Object.keys($audioCodecsStore).find(
						(codec) => codec.toLowerCase() === 'aac',
					);
					if (aacCodec) {
						properties.audioCodec = initialSelectedProperties.audioCodec = aacCodec as AudioCodecs;
					}
				}
			}
		}
	}
});

// React to relay server changes
$effect(() => {
	if ($relayMessageStore && $savedConfigStore !== undefined && $savedConfigStore.relay_server) {
		properties.relayServer = $savedConfigStore.relay_server ? $savedConfigStore.relay_server : '-1';
		if ($savedConfigStore?.relay_account !== undefined) {
			properties.relayAccount = $savedConfigStore.relay_account;
		}
	} else {
		properties.relayServer = '-1';
		properties.relayAccount = '-1';
	}
});

// Parse pipeline to populate encoder fields (during init or programmatic changes, not user interaction)
$effect.pre(() => {
	if (
		properties.pipeline &&
		$unparsedPipelinesStore !== undefined &&
		$LL &&
		(!userHasInteracted || isProgrammaticChange)
	) {
		const pipelineData = $unparsedPipelinesStore[properties.pipeline];
		if (!pipelineData) {
			return;
		}

		const parsedPipeline = parsePipelineName(pipelineData.name, {
			matchDeviceResolution: $LL.settings.matchDeviceResolution(),
			matchDeviceOutput: $LL.settings.matchDeviceOutput(),
		});

		properties.inputMode = parsedPipeline.format ?? undefined;
		properties.encoder = parsedPipeline.encoder ?? undefined;
		properties.resolution = parsedPipeline.resolution ?? undefined;
		properties.framerate = parsedPipeline.fps?.toString() ?? undefined;

		// Auto-select aac as default audio codec if pipeline supports audio and no codec is selected
		if (pipelineData.acodec && !properties.audioCodec && $audioCodecsStore) {
			const aacCodec = Object.keys($audioCodecsStore).find(
				(codec) => codec.toLowerCase() === 'aac',
			);
			if (aacCodec) {
				properties.audioCodec = aacCodec as AudioCodecs;
			}
		}
	}
});

$effect(() => {
	properties.pipeline =
		$groupedPipelinesStore &&
		properties.inputMode &&
		properties.encoder &&
		properties.resolution &&
		properties.framerate
			? $groupedPipelinesStore[properties.inputMode][properties.encoder][
					properties.resolution
				]?.find((pipeline) => {
					return pipeline.extraction.fps === properties.framerate;
				})?.identifier
			: undefined;
});

// Updated helper to use modular validation
function validateForm() {
	const result = validateStreamingForm(
		{
			inputMode: properties.inputMode,
			encoder: properties.encoder,
			resolution: properties.resolution,
			framerate: properties.framerate,
			bitrate: properties.bitrate,
			relayServer: properties.relayServer,
			srtlaServerAddress: properties.srtlaServerAddress,
			srtlaServerPort: properties.srtlaServerPort,
		},
		(key) => getTranslationByKey($LL, key),
	);

	formErrors = result.errors;
	return result.isValid;
}

// Updated helper to use modular update function
const handleMaxBitrateUpdate = () => {
	updateMaxBitrate(properties.bitrate, $isStreamingStore);
};

// Local framerate sorter to match EncoderCard's expected signature
type MinimalPipeline = { extraction: { fps?: string } };
const getSortedFramerates = (framerates: MinimalPipeline[]): MinimalPipeline[] => {
	return [...framerates].sort((a, b) => {
		const fpsA = a.extraction.fps;
		const fpsB = b.extraction.fps;
		if (typeof fpsA === 'string' && fpsA.toLowerCase().includes('match')) return -1;
		if (typeof fpsB === 'string' && fpsB.toLowerCase().includes('match')) return 1;
		const numA = parseFloat(String(fpsA));
		const numB = parseFloat(String(fpsB));
		const safeA = Number.isFinite(numA) ? numA : 0;
		const safeB = Number.isFinite(numB) ? numB : 0;
		return safeA - safeB;
	});
};

function onSubmitStreamingForm(event: Event) {
	event.preventDefault();

	if (!validateForm()) {
		return;
	}

	startStreamingWithCurrentConfig();
}

const startStreamingWithCurrentConfig = () => {
	// Try to dismiss all toasts first
	try {
		toast.dismiss();
	} catch (error) {
		console.warn('Could not dismiss toasts:', error);
	}

	const config = buildStreamingConfig(properties, { unparsedPipelines: $unparsedPipelinesStore });

	if (config) {
		startStreamingWithConfig(config);
	}
};

// Auto-selection handlers using modular functions
const handleInputModeChange = (value: string) => {
	// Only mark user interaction if not during initial restoration
	if (!isInitialMount) {
		userHasInteracted = true; // Mark that user has made a selection
	}
	isProgrammaticChange = true;
	const resetProps = resetDependentSelections('inputMode');
	properties = { ...properties, inputMode: value, ...resetProps };

	if (value && $groupedPipelinesStore) {
		const autoSelected = autoSelectNextOption('inputMode', properties, $groupedPipelinesStore);
		if (Object.keys(autoSelected).length > 0) {
			properties = { ...properties, ...autoSelected };
		}
	}
	isProgrammaticChange = false;
};

const handleEncoderChange = (value: string) => {
	userHasInteracted = true; // Mark that user has made a selection
	isProgrammaticChange = true;
	const resetProps = resetDependentSelections('encoder');
	properties = { ...properties, encoder: value, ...resetProps };

	if (value && $groupedPipelinesStore) {
		const autoSelected = autoSelectNextOption('encoder', properties, $groupedPipelinesStore);
		if (Object.keys(autoSelected).length > 0) {
			properties = { ...properties, ...autoSelected };
		}
	}
	isProgrammaticChange = false;
};

const handleResolutionChange = (value: string) => {
	userHasInteracted = true; // Mark that user has made a selection
	isProgrammaticChange = true;
	const resetProps = resetDependentSelections('resolution');
	properties = { ...properties, resolution: value, ...resetProps };

	if (value && $groupedPipelinesStore) {
		const autoSelected = autoSelectNextOption('resolution', properties, $groupedPipelinesStore);
		if (Object.keys(autoSelected).length > 0) {
			properties = { ...properties, ...autoSelected };
		}
	}
	isProgrammaticChange = false;
};

// Also mark user interaction for framerate changes
const handleFramerateChange = (value: string) => {
	userHasInteracted = true;
	properties.framerate = value;
};
</script>

<div class="from-background via-background to-accent/5 bg-gradient-to-br">
	<form class="relative" onsubmit={onSubmitStreamingForm}>
		<!-- Streaming Controls - Sticky Header -->
		<StreamingControls
			disabled={false}
			isStreaming={!!$isStreamingStore}
			onStart={startStreamingWithCurrentConfig}
			onStop={() => {
				// Try to dismiss all toasts first
				try {
					toast.dismiss();
				} catch (error) {
					console.warn('Could not dismiss toasts:', error);
				}

				// Stop streaming with proper toast cleanup via the global function
				if (window.stopStreamingWithNotificationClear) {
					window.stopStreamingWithNotificationClear();
				} else {
					// Fallback
					stopStreaming();
				}
			}}
		/>

		<!-- Main Content Area -->
		<div class="container mx-auto max-w-6xl px-4 py-6">
			<!-- Enhanced Grid Layout with equal heights -->
			<div class="grid gap-6 lg:grid-cols-3">
				<!-- Encoder Settings Card -->
				<div class="h-full">
					<EncoderCard
						{formErrors}
						{getSortedFramerates}
						{getSortedResolutions}
						groupedPipelines={$groupedPipelinesStore}
						isStreaming={!!$isStreamingStore}
						{normalizeValue}
						onBitrateChange={(value) => (properties.bitrate = value)}
						onBitrateOverlayChange={(checked) => (properties.bitrateOverlay = checked)}
						onEncoderChange={handleEncoderChange}
						onFramerateChange={handleFramerateChange}
						onInputModeChange={handleInputModeChange}
						onResolutionChange={handleResolutionChange}
						properties={{
							inputMode: properties.inputMode,
							encoder: properties.encoder,
							resolution: properties.resolution,
							framerate: properties.framerate,
							bitrate: properties.bitrate,
							bitrateOverlay: properties.bitrateOverlay,
						}}
						updateMaxBitrate={handleMaxBitrateUpdate}
					/>
				</div>

				<!-- Audio Settings Card -->
				<div class="h-full">
					<AudioCard
						audioCodecs={$audioCodecsStore}
						audioSources={$audioSourcesStore}
						isStreaming={!!$isStreamingStore}
						{normalizeValue}
						notAvailableAudioSource={$notAvailableAudioSourceStore}
						onAudioCodecChange={(value) => (properties.audioCodec = value as AudioCodecs)}
						onAudioDelayChange={(value) => (properties.audioDelay = value)}
						onAudioSourceChange={(value) => (properties.audioSource = value)}
						properties={{
							pipeline: properties.pipeline,
							audioSource: properties.audioSource,
							audioCodec: properties.audioCodec,
							audioDelay: properties.audioDelay,
						}}
						unparsedPipelines={$unparsedPipelinesStore}
					/>
				</div>

				<!-- Server Settings Card -->
				<div class="h-full">
					<ServerCard
						{formErrors}
						isStreaming={!!$isStreamingStore}
						{normalizeValue}
						onRelayAccountChange={(value) => (properties.relayAccount = value)}
						onRelayServerChange={(value) => {
							properties.relayServer = value;
							if (value === '-1') {
								properties.relayAccount = undefined;
							}
						}}
						onSrtLatencyChange={(value) => {
							properties.srtLatency = value;
							srtLatencyTouched = true;
						}}
						onSrtStreamIdChange={(value) => {
							properties.srtStreamId = value;
							srtStreamIdTouched = true;
						}}
						onSrtlaAddressChange={(value) => {
							properties.srtlaServerAddress = value;
							srtlaAddressTouched = true;
						}}
						onSrtlaPortChange={(value) => {
							properties.srtlaServerPort = value;
							srtlaPortTouched = true;
						}}
						properties={{
							relayServer: properties.relayServer,
							relayAccount: properties.relayAccount,
							srtlaServerAddress: properties.srtlaServerAddress,
							srtlaServerPort: properties.srtlaServerPort,
							srtStreamId: properties.srtStreamId,
							srtLatency: properties.srtLatency,
						}}
						relayMessage={$relayMessageStore}
					/>
				</div>
			</div>
		</div>
	</form>
</div>
