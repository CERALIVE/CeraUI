<script lang="ts">
import { getTranslationByKey, LL } from '@ceraui/i18n/svelte';
import type { AudioCodecs, Pipelines } from '@ceraui/rpc/schemas';
import { onDestroy } from 'svelte';
import { toast } from 'svelte-sonner';

import { autoSelectNextOption } from '$lib/components/streaming/StreamingAutoSelection';
import {
	buildStreamingConfig,
	startStreamingWithConfig,
} from '$lib/components/streaming/StreamingConfigService';
// Import new modular components
import { createStreamingStateManager } from '$lib/components/streaming/StreamingStateManager.svelte';
import {
	getSortedResolutions,
	normalizeValue,
	updateMaxBitrate,
} from '$lib/components/streaming/StreamingUtils';
import { validateStreamingForm } from '$lib/components/streaming/StreamingValidation';
import { parsePipelineName } from '$lib/helpers/PipelineHelper';
import { stopStreaming } from '$lib/helpers/SystemHelper';
import AudioCard from '$main/shared/AudioCard.svelte';
import EncoderCard from '$main/shared/EncoderCard.svelte';
import ServerCard from '$main/shared/ServerCard.svelte';
import StreamingControls from '$main/shared/StreamingControls.svelte';

type Properties = {
	inputMode: string | undefined;
	encoder: string | undefined;
	resolution: string | undefined;
	framerate: string | undefined;
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
const unparsedPipelines = $derived(stateManager.unparsedPipelines);
const audioCodecs = $derived(stateManager.audioCodecs);
const groupedPipelines = $derived(stateManager.groupedPipelines);
const isStreaming = $derived(stateManager.isStreaming);
const audioSources = $derived(stateManager.audioSources);
const notAvailableAudioSource = $derived(stateManager.notAvailableAudioSource);

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

// Track relay server/account touched state from parent (to prevent restore override)
let relayServerTouched = $state(false);
let relayAccountTouched = $state(false);

// Track encoder-related user interactions (separate from ServerCard)
let userHasInteracted = $state(false);

// Track initial restoration phase to prevent premature userHasInteracted setting
let isInitialMount = $state(true);
let initialMountTimeoutId: ReturnType<typeof setTimeout> | undefined;

// Single-shot: transition from initial mount phase after config is restored
$effect(() => {
	// Only schedule the timeout once when savedConfig and pipeline are both ready
	if (isInitialMount && savedConfig && properties.pipeline && initialMountTimeoutId === undefined) {
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
// Uses === undefined checks to correctly handle falsy values (false, 0, '')
$effect(() => {
	if (savedConfig) {
		const config = savedConfig;

		if (properties.srtLatency === undefined) {
			properties.srtLatency = config.srt_latency ?? 2000;
		}

		// Only restore fields that user hasn't specifically touched
		if (!srtlaPortTouched && properties.srtlaServerPort === undefined && config.srtla_port) {
			properties.srtlaServerPort = config.srtla_port;
		}

		if (!srtStreamIdTouched && properties.srtStreamId === undefined && config.srt_streamid) {
			properties.srtStreamId = config.srt_streamid;
		}

		if (!srtlaAddressTouched && properties.srtlaServerAddress === undefined && config.srtla_addr) {
			properties.srtlaServerAddress = config.srtla_addr;
		}

		// Use === undefined checks to properly handle 0, false, and '' as valid restored values
		if (initialSelectedProperties.audioDelay === undefined) {
			properties.audioDelay = initialSelectedProperties.audioDelay = config.delay ?? 0;
		}
		if (initialSelectedProperties.pipeline === undefined) {
			initialSelectedProperties.pipeline = config.pipeline;
			properties.pipeline = config.pipeline;
		}
		if (initialSelectedProperties.bitrate === undefined) {
			properties.bitrate = initialSelectedProperties.bitrate = config?.max_br ?? 5000;
		}

		// bitrateOverlay can legitimately be false, so check === undefined
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

// React to relay server changes - only restore if user hasn't touched the fields
$effect(() => {
	if (relayMessage && savedConfig !== undefined && savedConfig.relay_server) {
		// Only restore relay server if user hasn't touched it
		if (!relayServerTouched && properties.relayServer === undefined) {
			properties.relayServer = savedConfig.relay_server ? savedConfig.relay_server : '-1';
		}
		// Only restore relay account if user hasn't touched it
		if (
			!relayAccountTouched &&
			properties.relayAccount === undefined &&
			savedConfig?.relay_account !== undefined
		) {
			properties.relayAccount = savedConfig.relay_account;
		}
	} else if (properties.relayServer === undefined) {
		// Set defaults only if not yet set
		properties.relayServer = '-1';
		properties.relayAccount = '-1';
	}
});

// Parse pipeline to populate encoder fields (during init or programmatic changes, not user interaction)
$effect.pre(() => {
	if (
		properties.pipeline &&
		unparsedPipelines !== undefined &&
		$LL &&
		(!userHasInteracted || isProgrammaticChange)
	) {
		const pipelineData = unparsedPipelines[properties.pipeline];
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
		if (pipelineData.acodec && !properties.audioCodec && audioCodecs) {
			const aacCodec = Object.keys(audioCodecs).find((codec) => codec.toLowerCase() === 'aac');
			if (aacCodec) {
				properties.audioCodec = aacCodec as AudioCodecs;
			}
		}
	}
});

$effect(() => {
	// During initial mount, don't interfere with pipeline restoration
	if (isInitialMount) {
		return;
	}

	// Minimal validation effect - just clear pipeline when incomplete
	// All validation, auto-selection, and pipeline building is now handled in autoSelectNextOption
	if (
		!properties.inputMode ||
		!properties.encoder ||
		!properties.resolution ||
		!properties.framerate
	) {
		if (properties.pipeline) {
			properties.pipeline = undefined;
		}
	}
});

// Build pipeline when groupedPipelines becomes available and all fields are set
// This handles the case where config is restored before pipelines are loaded
$effect(() => {
	if (
		groupedPipelines &&
		properties.inputMode &&
		properties.encoder &&
		properties.resolution &&
		properties.framerate &&
		!properties.pipeline
	) {
		const result = autoSelectNextOption('framerate', properties, groupedPipelines);
		if (result.pipeline) {
			properties.pipeline = result.pipeline;
		}
	}
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
			pipeline: properties.pipeline,
			audioSource: properties.audioSource,
			audioCodec: properties.audioCodec,
		},
		(key) => getTranslationByKey($LL, key),
		{ unparsedPipelines },
	);

	formErrors = result.errors;
	return result.isValid;
}

// Updated helper to use modular update function
const handleMaxBitrateUpdate = () => {
	updateMaxBitrate(properties.bitrate, isStreaming);
};

// Local framerate sorter to match EncoderCard's expected signature
type MinimalPipeline = { extraction: { fps?: string | null } };
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

	// Ensure a pipeline is built before attempting to start
	if (
		!properties.pipeline &&
		properties.inputMode &&
		properties.encoder &&
		properties.resolution &&
		properties.framerate &&
		groupedPipelines
	) {
		const result = autoSelectNextOption('framerate', properties, groupedPipelines);
		properties = Object.assign({}, properties, result);
	}

	const config = buildStreamingConfig(properties, { unparsedPipelines });

	if (config) {
		startStreamingWithConfig(config);
	} else {
		toast.error('Unable to start streaming: incomplete or invalid selection.', {
			description:
				'Please ensure input mode, encoder, resolution, and framerate form a valid pipeline.',
		});
	}
};

// Auto-selection handlers using modular functions
const handleInputModeChange = (value: string) => {
	// Only mark user interaction if not during initial restoration
	if (!isInitialMount) {
		userHasInteracted = true;
	}
	isProgrammaticChange = true;

	// Unified flow: validate → clean → auto-select → build pipeline
	if (value && groupedPipelines) {
		const updatedProperties = { ...properties, inputMode: value };
		const result = autoSelectNextOption('inputMode', updatedProperties, groupedPipelines);
		properties = Object.assign({}, properties, { inputMode: value }, result);
	} else {
		properties = { ...properties, inputMode: value };
	}
	isProgrammaticChange = false;
};

const handleEncoderChange = (value: string) => {
	// Only mark user interaction if not during initial restoration
	if (!isInitialMount) {
		userHasInteracted = true;
	}
	isProgrammaticChange = true;

	// Unified flow: validate → clean → auto-select → build pipeline
	if (value && groupedPipelines) {
		const updatedProperties = { ...properties, encoder: value };
		const result = autoSelectNextOption('encoder', updatedProperties, groupedPipelines);
		properties = Object.assign({}, properties, { encoder: value }, result);
	} else {
		properties = { ...properties, encoder: value };
	}
	isProgrammaticChange = false;
};

const handleResolutionChange = (value: string) => {
	// Only mark user interaction if not during initial restoration
	if (!isInitialMount) {
		userHasInteracted = true;
	}
	isProgrammaticChange = true;

	// Unified flow: validate → clean → auto-select → build pipeline
	if (value && groupedPipelines) {
		const updatedProperties = { ...properties, resolution: value };
		const result = autoSelectNextOption('resolution', updatedProperties, groupedPipelines);
		properties = Object.assign({}, properties, { resolution: value }, result);
	} else {
		properties = { ...properties, resolution: value };
	}
	isProgrammaticChange = false;
};

const handleFramerateChange = (value: string) => {
	// Only mark user interaction if not during initial restoration
	if (!isInitialMount) {
		userHasInteracted = true;
	}
	isProgrammaticChange = true;

	// Unified flow: validate → build pipeline
	if (value && groupedPipelines) {
		const updatedProperties = { ...properties, framerate: value };
		const result = autoSelectNextOption('framerate', updatedProperties, groupedPipelines);
		properties = Object.assign({}, properties, { framerate: value }, result);
	} else {
		properties = { ...properties, framerate: value };
	}
	isProgrammaticChange = false;
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
						{getSortedFramerates}
						{getSortedResolutions}
						{groupedPipelines}
						isStreaming={!!isStreaming}
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
						{unparsedPipelines}
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

		<!-- Streaming Controls - Floating Button at Bottom -->
		<StreamingControls
			disabled={false}
			isStreaming={!!isStreaming}
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
			variant="floating"
		/>
	</form>
</div>
