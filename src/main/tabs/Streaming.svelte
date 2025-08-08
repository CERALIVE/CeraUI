<script lang="ts">
import { _, locale } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import {
  type GroupedPipelines,
  groupPipelinesByDeviceAndFormat,
  type HumanReadablePipeline,
  parsePipelineName,
} from '$lib/helpers/PipelineHelper';
import { type AudioCodecs, updateBitrate } from '$lib/helpers/SystemHelper';
import {
  AudioCodecsMessages,
  ConfigMessages,
  PipelinesMessages,
  RelaysMessages,
  StatusMessages,
} from '$lib/stores/websocket-store';
import type { AudioCodecsMessage, ConfigMessage, PipelinesMessage, RelayMessage } from '$lib/types/socket-messages';
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
// State variables
let groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined = $state(undefined);
let unparsedPipelines: PipelinesMessage | undefined = $state();

let isStreaming: boolean | undefined = $state();
// Audio Section
let audioSources: Array<string> = $state([]);

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
let notAvailableAudioSource: string | undefined = $state(undefined);
let initialSelectedProperties: InitialSelectedProperties = $state({
  audioDelay: undefined,
  audioSource: undefined,
  pipeline: undefined,
  audioCodec: undefined,
  bitrate: undefined,
  bitrateOverlay: false,
});

let audioCodecs: AudioCodecsMessage | undefined = $state();

let relayMessage: RelayMessage | undefined = $state();

let savedConfig: ConfigMessage | undefined = $state(undefined);
const normalizeValue = (value: number, min: number, max: number, step = 1) => {
  const stepped = Math.round((value - min) / step) * step + min;
  return Math.max(min, Math.min(max, stepped));
};

const updateMaxBitrate = () => {
  if (isStreaming) {
    updateBitrate(properties.bitrate);
  }
};
// Form state
let formErrors = $state<Record<string, string>>({});

AudioCodecsMessages.subscribe(audioCodecsMessage => {
  if (audioCodecsMessage && !audioCodecs) {
    audioCodecs = audioCodecsMessage;
  }
});

StatusMessages.subscribe(status => {
  if (status) {
    isStreaming = status.is_streaming;
    if (status.asrcs.length !== audioSources?.length) {
      audioSources = status.asrcs;

      // Re-evaluate audio source availability when the list is updated
      if (savedConfig?.asrc) {
        if (audioSources.includes(savedConfig.asrc)) {
          // The previously "unavailable" source is now available
          notAvailableAudioSource = undefined;
        } else {
          // Still not available
          notAvailableAudioSource = savedConfig.asrc;
        }
      }
    }
  }
});
// Subscribe to configuration messages
ConfigMessages.subscribe(config => {
  if (config) {
    savedConfig = config;
    if (properties.srtLatency === undefined) {
      properties.srtLatency = config.srt_latency ?? 2000;
    }

    if (!properties.srtlaServerPort && config.srtla_port) {
      properties.srtlaServerPort = config.srtla_port;
    }

    if (!properties.srtStreamId && config.srt_streamid) {
      properties.srtStreamId = config.srt_streamid;
    }

    if (!properties.srtlaServerAddress && config.srtla_addr) {
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
      properties.bitrateOverlay = initialSelectedProperties.bitrateOverlay = config?.bitrate_overlay ?? false;
    }
    if (!initialSelectedProperties.audioSource) {
      // Only mark as unavailable if we actually have the audio sources list
      // If audioSources is empty, we'll re-evaluate when it gets populated
      if (config.asrc) {
        if (audioSources.length > 0 && !audioSources.includes(config.asrc)) {
          notAvailableAudioSource = config.asrc;
        } else if (audioSources.length === 0) {
          // Don't make a decision yet - wait for audioSources to be populated
          notAvailableAudioSource = undefined;
        } else {
          notAvailableAudioSource = undefined;
        }
      } else {
        notAvailableAudioSource = undefined;
      }
      properties.audioSource = initialSelectedProperties.audioSource = config?.asrc ?? '';
    }
    if (!initialSelectedProperties.audioCodec) {
      properties.audioCodec = initialSelectedProperties.audioCodec = config.acodec;

      // If no audio codec in config but pipeline supports audio, default to aac
      if (!config.acodec && config.pipeline && unparsedPipelines && audioCodecs) {
        const pipelineData = unparsedPipelines[config.pipeline];
        if (pipelineData?.acodec) {
          const aacCodec = Object.keys(audioCodecs).find(codec => codec.toLowerCase() === 'aac');
          if (aacCodec) {
            properties.audioCodec = initialSelectedProperties.audioCodec = aacCodec;
          }
        }
      }
    }
  }
});

RelaysMessages.subscribe(message => {
  relayMessage = message;
  if (relayMessage && savedConfig !== undefined && savedConfig.relay_server) {
    properties.relayServer = savedConfig.relay_server ? savedConfig.relay_server : '-1';
    if (savedConfig?.relay_account !== undefined) {
      properties.relayAccount = savedConfig.relay_account;
    }
  } else {
    properties.relayServer = '-1';
    properties.relayAccount = '-1';
  }
});
// Subscribe to pipeline messages
PipelinesMessages.subscribe(message => {
  if (message) {
    unparsedPipelines = message;

    // Debug: Log pipeline structure to understand device types
    console.debug('Pipeline message received:', Object.keys(message).length, 'pipelines');
    const samplePipelines = Object.entries(message).slice(0, 3);
    console.debug(
      'Sample pipeline names:',
      samplePipelines.map(([key, value]) => value.name),
    );
  }
});

// Reactive pipeline processing that updates when locale changes
$effect(() => {
  if (unparsedPipelines && $locale) {
    const allGroupedPipelines = groupPipelinesByDeviceAndFormat(unparsedPipelines, {
      matchDeviceResolution: $_('settings.matchDeviceResolution'),
      matchDeviceOutput: $_('settings.matchDeviceOutput'),
    });

    // Get the first available device dynamically
    const availableDevices = Object.keys(allGroupedPipelines);
    if (availableDevices.length > 0) {
      groupedPipelines = allGroupedPipelines[availableDevices[0]];

      // Log for debugging what devices are available
      if (availableDevices.length > 1) {
        console.info('Multiple devices available:', availableDevices, 'Using:', availableDevices[0]);
      }
    } else {
      console.warn('No devices found in pipeline data');
      groupedPipelines = undefined;
    }
  }
});

$effect.pre(() => {
  if (properties.pipeline && unparsedPipelines !== undefined && $locale) {
    const pipelineData = unparsedPipelines[properties.pipeline];
    if (!pipelineData) {
      return; // Early return if pipeline data is not available
    }

    const parsedPipeline = parsePipelineName(pipelineData.name, {
      matchDeviceResolution: $_('settings.matchDeviceResolution'),
      matchDeviceOutput: $_('settings.matchDeviceOutput'),
    });
    properties.inputMode = parsedPipeline.format ?? undefined;

    properties.encoder = parsedPipeline.encoder ?? undefined;
    properties.resolution = parsedPipeline.resolution ?? undefined;

    properties.framerate = parsedPipeline.fps?.toString() ?? undefined;

    // Auto-select aac as default audio codec if pipeline supports audio and no codec is selected
    if (pipelineData.acodec && !properties.audioCodec && audioCodecs) {
      // Check if "aac" is available in the audio codecs
      const aacCodec = Object.keys(audioCodecs).find(codec => codec.toLowerCase() === 'aac');
      if (aacCodec) {
        properties.audioCodec = aacCodec;
      }
    }
  }
});

$effect(() => {
  if (groupedPipelines && properties.inputMode && properties.encoder && properties.resolution && properties.framerate) {
    properties.pipeline = groupedPipelines[properties.inputMode][properties.encoder][properties.resolution]?.find(
      pipeline => {
        return pipeline.extraction.fps === properties.framerate;
      },
    )?.identifier;
  } else {
    properties.pipeline = undefined;
  }
});

// Auto-select logic for encoding settings
function autoSelectNextOption(currentLevel: string) {
  if (!groupedPipelines) return;

  switch (currentLevel) {
    case 'inputMode':
      if (properties.inputMode) {
        // If there's only one encoding format option, auto-select it
        const encoders = Object.keys(groupedPipelines[properties.inputMode]);
        if (encoders.length === 1) {
          properties.encoder = encoders[0];
          // Continue chain to next level
          autoSelectNextOption('encoder');
        }
      }
      break;

    case 'encoder':
      if (properties.inputMode && properties.encoder) {
        // If there's only one resolution option, auto-select it
        const resolutions = Object.keys(groupedPipelines[properties.inputMode][properties.encoder]);
        if (resolutions.length === 1) {
          properties.resolution = resolutions[0];
          // Continue chain to next level
          autoSelectNextOption('resolution');
        }
      }
      break;

    case 'resolution':
      if (properties.inputMode && properties.encoder && properties.resolution) {
        // If there's only one framerate option, auto-select it
        const framerates = groupedPipelines[properties.inputMode][properties.encoder][properties.resolution];
        if (framerates.length === 1) {
          properties.framerate = framerates[0].extraction.fps ?? undefined;
        }
      }
      break;
  }
}

function validateForm() {
  formErrors = {};
  let hasErrors = false;

  // Validate Input Mode
  if (!properties.inputMode) {
    formErrors.inputMode = $_('settings.errors.inputModeRequired');
    toast.error($_('settings.errors.inputModeRequired'));
    hasErrors = true;
  }

  // Validate Encoding Format
  if (!properties.encoder) {
    formErrors.encoder = $_('settings.errors.encoderRequired');
    toast.error($_('settings.errors.encoderRequired'));
    hasErrors = true;
  }

  // Validate Encoding Resolution
  if (!properties.resolution) {
    formErrors.resolution = $_('settings.errors.resolutionRequired');
    toast.error($_('settings.errors.resolutionRequired'));
    hasErrors = true;
  }

  // Validate Framerate
  if (!properties.framerate) {
    formErrors.framerate = $_('settings.errors.framerateRequired');
    toast.error($_('settings.errors.framerateRequired'));
    hasErrors = true;
  }

  // Validate Bitrate
  if (!properties.bitrate || properties.bitrate < 2000 || properties.bitrate > 12000) {
    formErrors.bitrate = $_('settings.errors.bitrateInvalid');
    toast.error($_('settings.errors.bitrateInvalid'));
    hasErrors = true;
  }

  // Validate Receiver Server Configuration
  if (properties.relayServer === '-1' || properties.relayServer === undefined) {
    // Manual Configuration - validate SRTLA server settings
    if (!properties.srtlaServerAddress || properties.srtlaServerAddress.trim() === '') {
      formErrors.srtlaServerAddress = $_('settings.errors.srtlaServerAddressRequired');
      toast.error($_('settings.errors.srtlaServerAddressRequired'));
      hasErrors = true;
    }

    if (!properties.srtlaServerPort || properties.srtlaServerPort <= 0) {
      formErrors.srtlaServerPort = $_('settings.errors.srtlaServerPortRequired');
      toast.error($_('settings.errors.srtlaServerPortRequired'));
      hasErrors = true;
    }
  } else {
    // Automatic Configuration - validate relay server selection
    if (!properties.relayServer || properties.relayServer === '') {
      formErrors.relayServer = $_('settings.errors.relayServerRequired');
      toast.error($_('settings.errors.relayServerRequired'));
      hasErrors = true;
    }
  }

  // Note: SRT Stream ID is optional in manual configuration, so no validation needed

  // If no errors, show success message
  if (!hasErrors) {
    toast.success($_('settings.validation.allFieldsValid'));
  }

  return !hasErrors;
}

// Automatic bitrate updates are handled by the slider and input's change events

function onSubmitStreamingForm(event: Event) {
  event.preventDefault();

  if (!validateForm()) {
    return;
  }

  startStreamingWithCurrentConfig();
}

const startStreamingWithCurrentConfig = () => {
  let config: ConfigMessage = {};
  if (properties.pipeline) {
    config.pipeline = properties.pipeline;
  }

  // Safely access pipeline data with proper null checks
  if (!unparsedPipelines || !properties.pipeline) {
    console.warn('Cannot start streaming: missing pipeline data or pipeline selection');
    return;
  }

  const pipelineData = unparsedPipelines[properties.pipeline];
  if (!pipelineData) {
    console.warn('Cannot start streaming: pipeline data not found for', properties.pipeline);
    return;
  }

  if (pipelineData.asrc && properties.audioSource) {
    config.asrc = properties.audioSource;
  }
  if (pipelineData.acodec && properties.audioCodec) {
    config.acodec = properties.audioCodec;
  }
  if ((properties.relayServer == '-1' || properties.relayServer === undefined) && properties.srtlaServerAddress) {
    config.srtla_addr = properties.srtlaServerAddress;
    if (properties.srtlaServerPort !== undefined) {
      config.srtla_port = properties.srtlaServerPort;
    }
  } else if (properties.relayServer) {
    config.relay_server = properties.relayServer;
  }
  if (properties.srtLatency !== undefined) {
    config.srt_latency = properties.srtLatency;
  }

  if (properties.relayAccount == '-1' || properties.relayAccount === undefined) {
    config.srt_streamid = properties.srtStreamId ?? '';
  } else {
    config.relay_account = properties.relayAccount;
  }

  // Add safety checks for required numeric properties
  if (properties.audioDelay !== undefined) {
    config.delay = properties.audioDelay;
  }
  if (properties.bitrate !== undefined) {
    config.max_br = properties.bitrate;
  }
  if (properties.bitrateOverlay !== undefined) {
    config.bitrate_overlay = properties.bitrateOverlay;
  }

  // Directly dismiss all toasts first for immediate visual feedback
  toast.dismiss();

  // Then use the global function to handle the streaming
  if (window.startStreamingWithNotificationClear) {
    window.startStreamingWithNotificationClear(config);
  } else {
    // Fallback to direct function call if global function is not available
    import('$lib/helpers/SystemHelper').then(module => {
      module.startStreaming(config);
    });
  }
};

const getSortedFramerates = (framerates: HumanReadablePipeline[]) =>
  [...framerates].sort((a, b) => {
    // Put "match device output" or similar special options first
    const fpsA = a.extraction.fps;
    const fpsB = b.extraction.fps;

    if (typeof fpsA === 'string' && fpsA.toLowerCase().includes('match')) return -1;
    if (typeof fpsB === 'string' && fpsB.toLowerCase().includes('match')) return 1;

    // Convert to numbers for numeric comparison
    const numA = parseFloat(String(fpsA)) || 0;
    const numB = parseFloat(String(fpsB)) || 0;

    // Sort by numeric value
    return numA - numB;
  });

const getSortedResolutions = (resolutions: string[]) =>
  [...resolutions].sort((a, b) => {
    // Put "match device resolution" or similar special options first
    if (a.toLowerCase().includes('match') || a.toLowerCase().includes('device')) return -1;
    if (b.toLowerCase().includes('match') || b.toLowerCase().includes('device')) return 1;

    // Extract numeric values (like "720" from "720p")
    const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);

    // Sort by numeric value
    return numA - numB;
  });
</script>

<div class="from-background via-background to-accent/5 bg-gradient-to-br">
  <form onsubmit={onSubmitStreamingForm} class="relative">
    <!-- Streaming Controls - Sticky Header -->
    <StreamingControls {isStreaming} onStart={startStreamingWithCurrentConfig} onStop={() => {}} disabled={false} />

    <!-- Main Content Area -->
    <div class="container mx-auto max-w-6xl px-4 py-6">
      <!-- Enhanced Grid Layout with equal heights -->
      <div class="grid gap-6 lg:grid-cols-3">
        <!-- Encoder Settings Card -->
        <div class="h-full">
          <EncoderCard
            {groupedPipelines}
            properties={{
              inputMode: properties.inputMode,
              encoder: properties.encoder,
              resolution: properties.resolution,
              framerate: properties.framerate,
              bitrate: properties.bitrate,
              bitrateOverlay: properties.bitrateOverlay,
            }}
            {formErrors}
            {isStreaming}
            onInputModeChange={value => {
              properties.encoder = undefined;
              properties.resolution = undefined;
              properties.framerate = undefined;
              properties.inputMode = value;
              if (value) autoSelectNextOption('inputMode');
            }}
            onEncoderChange={value => {
              properties.encoder = value;
              properties.resolution = undefined;
              properties.framerate = undefined;
              if (value) autoSelectNextOption('encoder');
            }}
            onResolutionChange={value => {
              properties.resolution = value;
              properties.framerate = undefined;
              if (value) autoSelectNextOption('resolution');
            }}
            onFramerateChange={value => (properties.framerate = value)}
            onBitrateChange={value => (properties.bitrate = value)}
            onBitrateOverlayChange={checked => (properties.bitrateOverlay = checked)}
            {updateMaxBitrate}
            {normalizeValue}
            {getSortedResolutions}
            {getSortedFramerates} />
        </div>

        <!-- Audio Settings Card -->
        <div class="h-full">
          <AudioCard
            {audioCodecs}
            {unparsedPipelines}
            {audioSources}
            {notAvailableAudioSource}
            properties={{
              pipeline: properties.pipeline,
              audioSource: properties.audioSource,
              audioCodec: properties.audioCodec,
              audioDelay: properties.audioDelay,
            }}
            {isStreaming}
            onAudioSourceChange={value => (properties.audioSource = value)}
            onAudioCodecChange={value => (properties.audioCodec = value)}
            onAudioDelayChange={value => (properties.audioDelay = value)}
            {normalizeValue} />
        </div>

        <!-- Server Settings Card -->
        <div class="h-full">
          <ServerCard
            {relayMessage}
            properties={{
              relayServer: properties.relayServer,
              relayAccount: properties.relayAccount,
              srtlaServerAddress: properties.srtlaServerAddress,
              srtlaServerPort: properties.srtlaServerPort,
              srtStreamId: properties.srtStreamId,
              srtLatency: properties.srtLatency,
            }}
            {formErrors}
            {isStreaming}
            onRelayServerChange={value => {
              properties.relayServer = value;
              if (value === '-1') {
                properties.relayAccount = undefined;
              }
            }}
            onRelayAccountChange={value => (properties.relayAccount = value)}
            onSrtlaAddressChange={value => (properties.srtlaServerAddress = value)}
            onSrtlaPortChange={value => (properties.srtlaServerPort = value)}
            onSrtStreamIdChange={value => (properties.srtStreamId = value)}
            onSrtLatencyChange={value => (properties.srtLatency = value)}
            {normalizeValue} />
        </div>
      </div>
    </div>
  </form>
</div>
