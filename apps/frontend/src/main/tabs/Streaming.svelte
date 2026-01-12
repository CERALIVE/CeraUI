<script lang="ts">
import { getTranslationByKey, LL } from '@ceraui/i18n/svelte';
import type { AudioCodecs, Pipelines, Resolution, Framerate } from '@ceraui/rpc/schemas';
import { onDestroy } from 'svelte';
import { toast } from 'svelte-sonner';

import {
	buildStreamingConfig,
	startStreamingWithConfig,
} from '$lib/components/streaming/StreamingConfigService';
import { createStreamingStateManager } from '$lib/components/streaming/StreamingStateManager.svelte';
import {
	normalizeValue,
	updateMaxBitrate,
} from '$lib/components/streaming/StreamingUtils';
import { validateStreamingForm } from '$lib/components/streaming/StreamingValidation';
import { getDefaultResolution, getDefaultFramerate } from '$lib/helpers/PipelineHelper';
import { stopStreaming } from '$lib/helpers/SystemHelper';
import AudioCard from '$main/shared/AudioCard.svelte';
import EncoderCard from '$main/shared/EncoderCard.svelte';
import ServerCard from '$main/shared/ServerCard.svelte';
import StreamingControls from '$main/shared/StreamingControls.svelte';

type Properties = {
	source: string | undefined;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
	pipeline: keyof Pipelines | undefined;
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

// Create state manager with cleanup on component destroy
const stateManager = createStreamingStateManager();
onDestroy(() => {
	stateManager.cleanup();
});

// Extract reactive state using getters from the state manager
const savedConfig = $derived(stateManager.savedConfig);
const relayMessage = $derived(stateManager.relayMessage);
const pipelines = $derived(stateManager.pipelines);
const hardware = $derived(stateManager.hardware);
const audioCodecs = $derived(stateManager.audioCodecs);
const isStreaming = $derived(stateManager.isStreaming);
const audioSources = $derived(stateManager.audioSources);
const notAvailableAudioSource = $derived(stateManager.notAvailableAudioSource);

let properties: Properties = $state({
	source: undefined,
	resolution: undefined,
	framerate: undefined,
	pipeline: undefined,
	bitrate: undefined,
	bitrateOverlay: false,
	audioCodec: undefined,
	audioDelay: 0,
	audioSource: undefined,
	relayAccount: undefined,
	relayServer: undefined,
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

// Track which specific fields user has touched
let srtlaAddressTouched = $state(false);
let srtlaPortTouched = $state(false);
let srtStreamIdTouched = $state(false);
let relayServerTouched = $state(false);
let relayAccountTouched = $state(false);

// Track initial restoration phase
let isInitialMount = $state(true);
let initialMountTimeoutId: ReturnType<typeof setTimeout> | undefined;

// Single-shot: transition from initial mount phase after config is restored
$effect(() => {
	if (isInitialMount && savedConfig && properties.source && initialMountTimeoutId === undefined) {
		initialMountTimeoutId = setTimeout(() => {
			isInitialMount = false;
		}, 100);
	}
});

// Cleanup timeout on component destroy
onDestroy(() => {
	if (initialMountTimeoutId !== undefined) {
		clearTimeout(initialMountTimeoutId);
	}
});

// React to saved config changes and initialize properties
$effect(() => {
	if (savedConfig) {
		const config = savedConfig;

		if (properties.srtLatency === undefined) {
			properties.srtLatency = config.srt_latency ?? 2000;
		}

		if (!srtlaPortTouched && properties.srtlaServerPort === undefined && config.srtla_port) {
			properties.srtlaServerPort = config.srtla_port;
		}

		if (!srtStreamIdTouched && properties.srtStreamId === undefined && config.srt_streamid) {
			properties.srtStreamId = config.srt_streamid;
		}

		if (!srtlaAddressTouched && properties.srtlaServerAddress === undefined && config.srtla_addr) {
			properties.srtlaServerAddress = config.srtla_addr;
		}

		if (initialSelectedProperties.audioDelay === undefined) {
			properties.audioDelay = initialSelectedProperties.audioDelay = config.delay ?? 0;
		}
		
		// Restore source from saved pipeline (only if it exists in current pipelines)
		if (initialSelectedProperties.pipeline === undefined && config.pipeline && pipelines) {
			// Only restore if the saved pipeline exists as a valid source
			if (pipelines[config.pipeline]) {
				initialSelectedProperties.pipeline = config.pipeline;
				properties.pipeline = config.pipeline;
				properties.source = config.pipeline;
			}
			// If old format pipeline, clear it - user will need to reselect
		}
		
		if (initialSelectedProperties.bitrate === undefined) {
			properties.bitrate = initialSelectedProperties.bitrate = config?.max_br ?? 5000;
		}

		if (initialSelectedProperties.bitrateOverlay === undefined) {
			properties.bitrateOverlay = initialSelectedProperties.bitrateOverlay =
				config?.bitrate_overlay ?? false;
		}
		if (initialSelectedProperties.audioSource === undefined) {
			properties.audioSource = initialSelectedProperties.audioSource = config?.asrc ?? '';
		}
		if (initialSelectedProperties.audioCodec === undefined) {
			properties.audioCodec = initialSelectedProperties.audioCodec = config.acodec as AudioCodecs;
		}
	}
});

// React to relay server changes
$effect(() => {
	if (relayMessage && savedConfig !== undefined && savedConfig.relay_server) {
		if (!relayServerTouched && properties.relayServer === undefined) {
			properties.relayServer = savedConfig.relay_server ? savedConfig.relay_server : '-1';
		}
		if (
			!relayAccountTouched &&
			properties.relayAccount === undefined &&
			savedConfig?.relay_account !== undefined
		) {
			properties.relayAccount = savedConfig.relay_account;
		}
	} else if (properties.relayServer === undefined) {
		properties.relayServer = '-1';
		properties.relayAccount = '-1';
	}
});

// Set pipeline key when source changes
$effect(() => {
	if (properties.source && pipelines) {
		const pipeline = pipelines[properties.source];
		if (pipeline) {
			properties.pipeline = properties.source;
			
			// Set default resolution and framerate if not already set
			if (!properties.resolution && pipeline.defaultResolution) {
				properties.resolution = pipeline.defaultResolution;
			}
			if (!properties.framerate && pipeline.defaultFramerate) {
				properties.framerate = pipeline.defaultFramerate;
			}
			
			// Auto-select AAC codec if pipeline supports audio
			if (pipeline.supportsAudio && !properties.audioCodec && audioCodecs) {
				const aacCodec = Object.keys(audioCodecs).find((codec) => codec.toLowerCase() === 'aac');
				if (aacCodec) {
					properties.audioCodec = aacCodec as AudioCodecs;
				}
			}
		}
	}
});

function validateForm() {
	const result = validateStreamingForm(
		{
			source: properties.source,
			resolution: properties.resolution,
			framerate: properties.framerate,
			bitrate: properties.bitrate,
			relayServer: properties.relayServer,
			srtlaServerAddress: properties.srtlaServerAddress,
			srtlaServerPort: properties.srtlaServerPort,
			pipeline: properties.pipeline,
			audioSource: properties.audioSource,
			audioCodec: properties.audioCodec,
		},
		(key) => getTranslationByKey($LL, key),
		{ pipelines },
	);

	formErrors = result.errors;
	return result.isValid;
}

const handleMaxBitrateUpdate = () => {
	updateMaxBitrate(properties.bitrate, isStreaming);
};

function onSubmitStreamingForm(event: Event) {
	event.preventDefault();

	if (!validateForm()) {
		return;
	}

	startStreamingWithCurrentConfig();
}

const startStreamingWithCurrentConfig = () => {
	try {
		toast.dismiss();
	} catch (error) {
		console.warn('Could not dismiss toasts:', error);
	}

	const config = buildStreamingConfig(properties, { pipelines });

	if (config) {
		startStreamingWithConfig(config);
	} else {
		toast.error('Unable to start streaming: incomplete or invalid selection.', {
			description: 'Please ensure video source is selected.',
		});
	}
};

// Handler functions
const handleSourceChange = (value: string) => {
	properties.source = value;
	properties.pipeline = value;
	
	// Apply defaults from pipeline metadata
	if (pipelines && pipelines[value]) {
		const pipeline = pipelines[value];
		if (pipeline.defaultResolution) {
			properties.resolution = pipeline.defaultResolution;
		}
		if (pipeline.defaultFramerate) {
			properties.framerate = pipeline.defaultFramerate;
		}
	}
};

const handleResolutionChange = (value: Resolution) => {
	properties.resolution = value;
};

const handleFramerateChange = (value: Framerate) => {
	properties.framerate = value;
};
</script>

<div class="from-background via-background to-accent/5 bg-gradient-to-br pb-4">
	<form class="relative" onsubmit={onSubmitStreamingForm}>
		<!-- Main Content Area -->
		<div class="container mx-auto max-w-6xl px-4 py-6">
			<!-- Enhanced Grid Layout with equal heights -->
			<div class="grid items-stretch gap-6 lg:grid-cols-3">
				<!-- Encoder Settings Card -->
				<div class="h-full">
					<EncoderCard
						{formErrors}
						{pipelines}
						{hardware}
						isStreaming={!!isStreaming}
						{normalizeValue}
						onBitrateChange={(value) => (properties.bitrate = value)}
						onBitrateOverlayChange={(checked) => (properties.bitrateOverlay = checked)}
						onSourceChange={handleSourceChange}
						onResolutionChange={handleResolutionChange}
						onFramerateChange={handleFramerateChange}
						properties={{
							source: properties.source,
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
						{audioCodecs}
						{audioSources}
						isStreaming={!!isStreaming}
						{normalizeValue}
						{notAvailableAudioSource}
						onAudioCodecChange={(value) => (properties.audioCodec = value as AudioCodecs)}
						onAudioDelayChange={(value) => (properties.audioDelay = value)}
						onAudioSourceChange={(value) => (properties.audioSource = value)}
						properties={{
							pipeline: properties.pipeline,
							audioSource: properties.audioSource,
							audioCodec: properties.audioCodec,
							audioDelay: properties.audioDelay,
						}}
						pipelines={pipelines}
					/>
				</div>

				<!-- Server Settings Card -->
				<div class="h-full">
					<ServerCard
						{formErrors}
						isStreaming={!!isStreaming}
						{normalizeValue}
						onRelayAccountChange={(value) => {
							properties.relayAccount = value;
							relayAccountTouched = true;
						}}
						onRelayServerChange={(value) => {
							properties.relayServer = value;
							relayServerTouched = true;
							if (value === '-1') {
								properties.relayAccount = undefined;
							}
						}}
						onSrtLatencyChange={(value) => {
							properties.srtLatency = value;
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
						{relayMessage}
					/>
				</div>
			</div>
		</div>

		<!-- Streaming Controls -->
		<StreamingControls
			disabled={false}
			isStreaming={!!isStreaming}
			onStart={startStreamingWithCurrentConfig}
			onStop={() => {
				try {
					toast.dismiss();
				} catch (error) {
					console.warn('Could not dismiss toasts:', error);
				}

				if (window.stopStreamingWithNotificationClear) {
					window.stopStreamingWithNotificationClear();
				} else {
					stopStreaming();
				}
			}}
			variant="floating"
		/>
	</form>
</div>
