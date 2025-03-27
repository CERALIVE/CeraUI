<script lang="ts">
import { Binary, ServerIcon, Volume } from 'lucide-svelte';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Slider } from '$lib/components/ui/slider';
import {
  type GroupedPipelines,
  groupPipelinesByDeviceAndFormat,
  type HumanReadablePipeline,
  parsePipelineName,
} from '$lib/helpers/PipelineHelper';
import { type AudioCodecs } from '$lib/helpers/SystemHelper';
import {
  AudioCodecsMessages,
  ConfigMessages,
  PipelinesMessages,
  RelaysMessages,
  StatusMessages,
} from '$lib/stores/websocket-store';
import type { AudioCodecsMessage, ConfigMessage, PipelinesMessage, RelayMessage } from '$lib/types/socket-messages';

type Properties = {
  inputMode: string | undefined;
  encoder: string | undefined;
  resolution: string | undefined;
  framerate: string | undefined;
  pipeline: keyof PipelinesMessage | undefined;
  bitrate: number | undefined;
  audioSource: string | undefined;
  audioCodec: string | undefined;
  audioDelay: number | undefined;
  relayServer: string | undefined;
  relayAccount: string | undefined;
  srtlaServerAddress: string | undefined;
  srtlaServerPort: number | undefined;
  srtStreamId: string | undefined;
  srtLatency: number | undefined;
};

// for selected preload
type InitialSelectedProperties = {
  audioSource: string | undefined;
  pipeline: keyof PipelinesMessage | undefined;
  audioCodec: AudioCodecs | undefined;
  audioDelay: number | undefined;
  bitrate: number | undefined;
};
// State variables
let groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined = $state(undefined);
let unparsedPipelines: PipelinesMessage | undefined = $state();

let isStreaming: boolean | undefined = $state();
// Audio Section
let audioSources: Array<string> = $state([]);

let properties: Properties = $state({
  bitrate: undefined,
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
});

let audioCodecs: AudioCodecsMessage | undefined = $state();

let relayMessage: RelayMessage | undefined = $state();

let savedConfig: ConfigMessage | undefined = $state(undefined);
const normalizeValue = (value: number, min: number, max: number, step = 1) =>
  Math.max(min, Math.min(max, Math.round(value / step) * step));

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
    if (!initialSelectedProperties.audioSource) {
      if (config.asrc && !audioSources.includes(config.asrc)) {
        notAvailableAudioSource = config.asrc;
      } else {
        notAvailableAudioSource = undefined;
      }
      properties.audioSource = initialSelectedProperties.audioSource = config?.asrc ?? '';
    }
    if (!initialSelectedProperties.audioCodec) {
      properties.audioCodec = initialSelectedProperties.audioCodec = config.acodec;
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
    if (!unparsedPipelines) {
      groupedPipelines = groupPipelinesByDeviceAndFormat(message)['rk3588'];
      unparsedPipelines = message;
    }
  }
});

$effect.pre(() => {
  if (properties.pipeline && unparsedPipelines !== undefined) {
    const parsedPipeline = parsePipelineName(unparsedPipelines[properties.pipeline].name);
    properties.inputMode = parsedPipeline.format ?? undefined;

    properties.encoder = parsedPipeline.encoder ?? undefined;
    properties.resolution = parsedPipeline.resolution ?? undefined;

    properties.framerate = parsedPipeline.fps?.toString() ?? undefined;
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

  if (!properties.pipeline) {
    formErrors.pipeline = $_('settings.errors.pipelineRequired');
    return false;
  }

  // Add more validation as needed

  return Object.keys(formErrors).length === 0;
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
  let config: { [key: string]: string | number } = {};
  if (properties.pipeline) {
    config.pipeline = properties.pipeline;
  }
  const pipelineData = unparsedPipelines![properties.pipeline!]!;

  if (pipelineData.asrc) {
    config.asrc = properties.audioSource!;
  }
  if (pipelineData.acodec) {
    config.acodec = properties.audioCodec!;
  }
  if ((properties.relayServer == '-1' || properties.relayServer === undefined) && properties.srtlaServerAddress) {
    config.srtla_addr = properties.srtlaServerAddress;
    if (properties.srtlaServerPort !== undefined) {
      config.srtla_port = properties.srtlaServerPort;
    }
  } else {
    config.relay_server = properties.relayServer!;
  }
  if (properties.srtLatency !== undefined) {
    config.srt_latency = properties.srtLatency;
  }

  if (properties.relayAccount == '-1' || properties.relayAccount === undefined) {
    config.srt_streamid = properties.srtStreamId ?? '';
  } else {
    config.relay_account = properties.relayAccount;
  }
  config.delay = properties.audioDelay!;
  config.max_br = properties.bitrate!;

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

<div class="flex-col md:flex">
  <div class="flex-1 space-y-4 p-8 pt-6">
    <form onsubmit={onSubmitStreamingForm}>
      {#if isStreaming}
        <Button
          type="button"
          class="w-[100%] bg-yellow-600 hover:bg-yellow-600/80"
          onclick={() => {
          // Directly dismiss all toasts first for immediate visual feedback
          toast.dismiss();

          if (window.stopStreamingWithNotificationClear) {
            window.stopStreamingWithNotificationClear();
          } else {
            // Fallback
            import('$lib/helpers/SystemHelper').then(module => {
              module.stopStreaming();
            });
          }
        }}
          >{$_('settings.stopStreaming')}</Button>
      {:else}
        <Button type="submit" class="w-[100%]">{$_('settings.startStreaming')}</Button>
      {/if}
    </form>

    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card.Root class="md:row-span-2 lg:row-span-1">
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('settings.encoderSettings')}</Card.Title>
          <Binary class="text-muted-foreground h-4 w-4" />
        </Card.Header>
        <Card.Content>
          <div class="grid gap-4">
            <!-- Input Mode Selection -->
            <div class="grid gap-1">
              <Label for="inputMode">{$_('settings.inputMode')}</Label>
              <Select.Root
                type="single"
                disabled={isStreaming}
                value={properties.inputMode}
                onValueChange={value => {
                  properties.encoder = undefined;
                  properties.resolution = undefined;
                  properties.framerate = undefined;
                  properties.inputMode = value;
                  // Auto-select the next level if there's only one option
                  if (value) autoSelectNextOption('inputMode');
                }}>
                <Select.Trigger id="inputMode">
                  {properties.inputMode ? properties.inputMode.toUpperCase() : $_('settings.selectInputMode')}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if groupedPipelines}
                      {#each Object.entries(groupedPipelines) as [pipelineKey, _]}
                        {@const label = pipelineKey.toUpperCase().split(' ')[0]}
                        <Select.Item value={pipelineKey} {label}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
              {#if properties.inputMode && properties.inputMode.includes('usb')}
                <p class="text-muted-foreground mt-1 text-xs">
                  {$_('settings.djiCameraMessage')}
                </p>
              {/if}
            </div>

            <!-- Encoding Format Selection -->
            <div class="grid gap-1">
              <Label for="encodingFormat">{$_('settings.encodingFormat')}</Label>
              <Select.Root
                type="single"
                disabled={isStreaming || !properties.inputMode}
                value={properties.encoder}
                onValueChange={value => {
                  properties.encoder = value;
                  properties.resolution = undefined;
                  properties.framerate = undefined;

                  // Auto-select the next level if there's only one option
                  if (value) {
                    autoSelectNextOption('encoder');
                  }
                }}>
                <Select.Trigger id="encodingFormat">
                  {properties.encoder ? properties.encoder.toUpperCase() : $_('settings.selectEncodingOutputFormat')}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if properties.inputMode && groupedPipelines?.[properties.inputMode]}
                      {#each Object.keys(groupedPipelines[properties.inputMode]) as encoder}
                        <Select.Item value={encoder} label={encoder.toUpperCase()}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </div>

            <!-- Encoding Resolution Selection -->
            <div class="grid gap-1">
              <Label for="encodingResolution">{$_('settings.encodingResolution')}</Label>
              <Select.Root
                type="single"
                disabled={isStreaming || !properties.encoder}
                value={properties.resolution}
                onValueChange={value => {
                  properties.resolution = value;
                  properties.framerate = undefined;

                  // Auto-select the next level if there's only one option
                  if (value) {
                    autoSelectNextOption('resolution');
                  }
                }}>
                <Select.Trigger id="encodingResolution">
                  {properties.resolution ?? $_('settings.selectEncodingResolution')}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if properties.encoder && properties.inputMode && groupedPipelines?.[properties.inputMode]?.[properties.encoder]}
                      {@const resolutions = getSortedResolutions(
                        Object.keys(groupedPipelines[properties.inputMode][properties.encoder]),
                      )}
                      {#each resolutions as resolution}
                        <Select.Item value={resolution} label={resolution}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </div>

            <!-- Framerate Selection -->
            <div class="grid gap-1">
              <Label for="framerate">{$_('settings.framerate')}</Label>
              <Select.Root
                type="single"
                disabled={isStreaming || !properties.resolution}
                value={properties.framerate!}
                onValueChange={value => (properties.framerate = value)}>
                <Select.Trigger id="framerate">
                  {properties.framerate ?? $_('settings.selectFramerate')}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if properties.encoder && properties.inputMode && properties.resolution && groupedPipelines?.[properties.inputMode]?.[properties.encoder][properties.resolution]}
                      {@const framerates = getSortedFramerates(
                        groupedPipelines[properties.inputMode][properties.encoder][properties.resolution],
                      )}
                      {#each framerates as framerate}
                        <Select.Item value={framerate.extraction.fps!} label={framerate.extraction.fps!}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>

              {#if formErrors.pipeline}
                <p class="text-sm text-red-500">{formErrors.pipeline}</p>
              {/if}

              <div class="mt-4">
                <Label for="bitrate">{$_('settings.bitrate')}</Label>
                <Slider
                  type="single"
                  id="bitrate"
                  class="my-6"
                  value={properties.bitrate}
                  max={12000}
                  min={500}
                  step={50}
                  onValueChange={value => {
                    properties.bitrate = value;
                  }} />
                <Input
                  type="number"
                  step="50"
                  max={12000}
                  min={500}
                  bind:value={properties.bitrate}
                  onblur={() => {
                    properties.bitrate = normalizeValue(properties.bitrate!, 2000, 12000, 50);
                  }}></Input>
                {#if isStreaming}
                  <p class="text-xs">{$_('settings.changeBitrateNotice')}</p>
                {/if}
              </div>
            </div>
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root class="row-span-1">
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('settings.audioSettings')}</Card.Title>
          <Volume class="text-muted-foreground h-4 w-4" />
        </Card.Header>
        <Card.Content>
          <div class="grid gap-4">
            {#if audioCodecs && unparsedPipelines && properties.pipeline && unparsedPipelines[properties.pipeline!].asrc}
              <div class="grid gap-1">
                <Label for="audioSource">{$_('settings.audioSource')}</Label>
                <Select.Root
                  type="single"
                  disabled={isStreaming}
                  value={properties.audioSource}
                  onValueChange={value => (properties.audioSource = value)}>
                  <Select.Trigger id="audioSource">
                    {!properties.audioSource
                      ? $_('settings.selectAudioSource')
                      : properties.audioSource !== notAvailableAudioSource
                        ? properties.audioSource
                        : `${notAvailableAudioSource} (${$_('settings.notAvailableAudioSource')})`}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      {#if audioSources}
                        {#each audioSources as audioSource}
                          <Select.Item value={audioSource} label={audioSource}></Select.Item>
                        {/each}
                      {/if}
                      {#if notAvailableAudioSource}
                        <Select.Item
                          value={notAvailableAudioSource}
                          label={`${notAvailableAudioSource} (${$_('settings.notAvailableAudioSource')})`}
                        ></Select.Item>
                      {/if}
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if audioCodecs && unparsedPipelines && properties.pipeline && unparsedPipelines[properties.pipeline].acodec}
              <div class="grid gap-1">
                <Label for="audioCodec">{$_('settings.audioCodec')}</Label>
                <Select.Root
                  type="single"
                  disabled={isStreaming}
                  value={properties.audioCodec}
                  onValueChange={value => (properties.audioCodec = value)}>
                  <Select.Trigger id="audioCodec">
                    {$_(
                      properties.audioCodec
                        ? Object.entries(audioCodecs).find(acodec => acodec[0] === properties.audioCodec)![1]
                        : 'settings.selectAudioCodec',
                    )}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      {#each Object.entries(audioCodecs) as [codec, label]}
                        <Select.Item value={codec} {label}></Select.Item>
                      {/each}
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
                <div class="mt-4">
                  <Label for="audioDelay">{$_('settings.audioDelay')}</Label>
                  <Slider
                    type="single"
                    id="audioDelay"
                    class="my-6"
                    value={properties.audioDelay}
                    onValueChange={value => (properties.audioDelay = value)}
                    disabled={isStreaming}
                    max={2000}
                    min={-2000}
                    step={5}></Slider>
                  <Input
                    id="audioDelayInput"
                    bind:value={properties.audioDelay}
                    type="number"
                    step="5"
                    min="-2000"
                    max="2000"
                    disabled={isStreaming}
                    onblur={() => {
                      properties.audioDelay = normalizeValue(properties.audioDelay!, 2000, 12000, 50);
                    }}></Input>
                </div>
              </div>
            {/if}

            {#if audioCodecs && unparsedPipelines && properties.pipeline && !unparsedPipelines[properties.pipeline].acodec && !unparsedPipelines[properties.pipeline].asrc}
              <div class="mt-2">
                <h3>{$_('settings.noAudioSettingSupport')}</h3>
              </div>
            {/if}

            {#if audioCodecs && unparsedPipelines && !properties.pipeline}
              <div class="mt-2">
                <h3>{$_('settings.audioSettingsMessage')}</h3>
              </div>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root class="row-span-1">
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('settings.receiverServer')}</Card.Title>
          <ServerIcon class="text-muted-foreground h-4 w-4" />
        </Card.Header>
        <Card.Content>
          <div class="grid gap-4">
            <div class="grid gap-1">
              <Label for="relayServer">{$_('settings.relayServer')}</Label>
              <Select.Root
                type="single"
                value={properties.relayServer}
                disabled={relayMessage === undefined || isStreaming}
                onValueChange={value => {
                  properties.relayServer = value;
                  if (value === '-1') {
                    properties.relayAccount = undefined;
                  }
                }}>
                <Select.Trigger id="relayServer">
                  {properties.relayServer !== undefined && properties.relayServer !== '-1' && relayMessage?.servers
                    ? Object.entries(relayMessage.servers).find(server => server[0] === properties.relayServer)![1].name
                    : $_('settings.manualConfiguration')}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    <Select.Item value="-1">{$_('settings.manualConfiguration')}</Select.Item>
                    {#if relayMessage?.servers}
                      {#each Object.entries(relayMessage?.servers) as [server, serverInfo]}
                        <Select.Item value={server} label={serverInfo.name}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </div>

            {#if properties.relayServer === '-1' || properties.relayServer === undefined}
              <div class="grid gap-1">
                <Label for="srtlaServerAddress">{$_('settings.srtlaServerAddress')}</Label>
                <Input id="srtlaServerAddress" bind:value={properties.srtlaServerAddress} disabled={isStreaming}
                ></Input>
              </div>
            {:else}
              <div class="grid gap-1">
                <Label for="relayServerAccount">{$_('settings.relayServerAccount')}</Label>
                <Select.Root
                  type="single"
                  disabled={relayMessage === undefined || isStreaming}
                  onValueChange={value => (properties.relayAccount = value)}
                  value={properties.relayAccount}>
                  <Select.Trigger id="relayServerAccount">
                    {properties.relayAccount === undefined ||
                    properties.relayAccount === '-1' ||
                    relayMessage?.accounts === undefined
                      ? $_('settings.manualConfiguration')
                      : relayMessage.accounts[properties.relayAccount].name}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      <Select.Item value="-1">{$_('settings.manualConfiguration')}</Select.Item>
                      {#if relayMessage?.servers}
                        {#each Object.entries(relayMessage?.accounts) as [account, accountInfo]}
                          <Select.Item value={account} label={accountInfo.name}></Select.Item>
                        {/each}
                      {/if}
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if properties.relayServer === '-1' || properties.relayServer === undefined}
              <div class="grid gap-1">
                <Label for="srtlaServerPort">{$_('settings.srtlaServerPort')}</Label>
                <Input id="srtlaServerPort" type="number" bind:value={properties.srtlaServerPort} disabled={isStreaming}
                ></Input>
              </div>
            {/if}
            {#if properties.relayAccount === '-1' || properties.relayAccount === undefined}
              <div class="grid gap-1">
                <Label for="srtStreamId">{$_('settings.srtStreamId')}</Label>
                <Input id="srtStreamId" bind:value={properties.srtStreamId} disabled={isStreaming}></Input>
              </div>
            {/if}

            {#if properties.srtLatency !== undefined}
              <div class="grid gap-1">
                <Label for="srtLatency">{$_('settings.srtLatency')}</Label>
                <Slider
                  id="srtLatency"
                  type="single"
                  class="my-6"
                  value={properties.srtLatency}
                  max={12000}
                  min={2000}
                  step={50}
                  onValueChange={value => (properties.srtLatency = value)}
                  disabled={isStreaming}></Slider>
                <Input
                  id="srtLatencyInput"
                  type="number"
                  step="1"
                  bind:value={properties.srtLatency}
                  disabled={isStreaming}
                  onblur={() => {
                    properties.srtLatency = normalizeValue(properties.srtLatency!, 2000, 12000, 50);
                  }}></Input>
              </div>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
</div>
