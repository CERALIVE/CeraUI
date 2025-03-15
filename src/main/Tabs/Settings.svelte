<script lang="ts">
import { Binary, ServerIcon, Volume } from 'lucide-svelte';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';
import type { AudioCodecsMessage, ConfigMessage, PipelinesMessage, RelayMessage } from '$lib/types/socket-messages';
import type { Selected } from 'bits-ui';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Slider } from '$lib/components/ui/slider';

import { type GroupedPipelines, groupPipelinesByDeviceAndFormat, parsePipelineName } from '$lib/helpers/PipelineHelper';
import { type AudioCodecs, updateBitrate } from '$lib/helpers/SystemHelper';
import {
  AudioCodecsMessages,
  ConfigMessages,
  PipelinesMessages,
  RelaysMessages,
  StatusMessages,
} from '$lib/stores/websocket-store';

type SelectInputString = Selected<string | null | undefined> | undefined;
type SelectInputNumberOrString = Selected<number | string | null | undefined> | undefined;

// State variables
let groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined = $state(undefined);
let selectedInputMode: SelectInputString = $state();

// Encoder Section
let selectedEncoder: SelectInputString = $state();
let selectedResolution: SelectInputString = $state();
let selectedFramerate: SelectInputNumberOrString = $state();
let unparsedPipelines: PipelinesMessage | undefined = $state();
let selectedPipeline: keyof PipelinesMessage | undefined = $state();
let initialSelectedPipeline: keyof PipelinesMessage | undefined = $state();

let selectedBitrate: number = $state(0);
// eslint-disable-next-line unused-imports/no-unused-vars
let areThereChanges: boolean = $state(false);
let initialSelectedBitrate: number | undefined = $state();
let isStreaming: boolean | undefined = $state();

// Audio Section
let audioSources: Array<string> = $state([]);
let initialSelectedAudioSource: string | undefined = $state();
let selectedAudioSource: SelectInputString = $state();
let audioCodecs: AudioCodecsMessage | undefined = $state();

let initialSelectedAudioCodec: AudioCodecs | undefined = $state();
let selectedAudioCodec: SelectInputString = $state();
let initialSelectedAudioDelay: number | undefined = $state();
let selectedAudioDelay: number = $state(0);

// SRTLA Config
let srtlaServerAddress: string | undefined = $state();
let srtlaServerPort: number | undefined = $state();
let srtStreamId: string | undefined = $state();
let srtLatency: number | undefined = $state();
let relayMessage: RelayMessage | undefined = $state();

const defaultRelaySelection = { value: '-1', label: $_('settings.manualConfiguration') };
let selectedRelayServer: typeof defaultRelaySelection | undefined = $state(undefined);
let selectedRelayAccount: typeof defaultRelaySelection | undefined = $state(undefined);

let savedConfig: ConfigMessage | undefined = $state(undefined);
const normalizeValue = (value: number, min: number, max: number, step = 1) =>
  Math.max(min, Math.min(max, Math.round(value / step) * step));

// Form state
let formErrors = $state<Record<string, string>>({});
let justSubmitted = $state(false);

AudioCodecsMessages.subscribe(audioCodecsMessage => {
  if (audioCodecsMessage && !audioCodecs) {
    audioCodecs = audioCodecsMessage;
  }
});

StatusMessages.subscribe(status => {
  if (status) {
    isStreaming = status.is_streaming;
    if (audioCodecs && initialSelectedAudioCodec && !selectedAudioCodec) {
      selectedAudioCodec = {
        value: initialSelectedAudioCodec,
        label: audioCodecs[initialSelectedAudioCodec],
      };
    }

    if (status.asrcs.length !== audioSources?.length) {
      audioSources = status.asrcs;
      if (selectedAudioSource && audioSources) {
        if (!audioSources.includes(`${selectedAudioSource.value}`)) {
          selectedAudioSource.label = `${selectedAudioSource.value} (Not Available)`;
        } else {
          selectedAudioSource.label = selectedAudioSource?.value ?? undefined;
        }
      }
    }
  }
});
// Subscribe to configuration messages
ConfigMessages.subscribe(config => {
  if (config) {
    savedConfig = config;
    if (srtLatency === undefined) {
      srtLatency = config.srt_latency ?? 2000;
    }

    if (!srtlaServerPort && config.srtla_port) {
      srtlaServerPort = config.srtla_port;
    }

    if (!srtStreamId && config.srt_streamid) {
      srtStreamId = config.srt_streamid;
    }

    if (!srtlaServerAddress && config.srtla_addr) {
      srtlaServerAddress = config.srtla_addr;
    }

    if (initialSelectedAudioDelay === undefined) {
      initialSelectedAudioDelay = config.delay ?? 0;
      selectedAudioDelay = config.delay ?? 0;
    }
    if (!initialSelectedPipeline) {
      initialSelectedPipeline = config.pipeline;
      selectedPipeline = config.pipeline;
    }
    if (!initialSelectedBitrate) {
      initialSelectedBitrate = config?.max_br ?? 5000;
      selectedBitrate = config?.max_br ?? 5000;
    }
    if (!initialSelectedAudioSource) {
      initialSelectedAudioSource = config?.asrc ?? '';
      selectedAudioSource = { value: config?.asrc, label: config?.asrc };
    }
    if (!initialSelectedAudioCodec) {
      initialSelectedAudioCodec = config.acodec;
    }
  }
});

RelaysMessages.subscribe(message => {
  relayMessage = message;
  if (relayMessage && savedConfig !== undefined && savedConfig.relay_server) {
    selectedRelayServer = savedConfig.relay_server
      ? { value: savedConfig.relay_server, label: message.servers[savedConfig.relay_server].name }
      : defaultRelaySelection;
    if (savedConfig?.relay_account !== undefined) {
      selectedRelayAccount = {
        value: savedConfig.relay_account,
        label: message.accounts[savedConfig.relay_account].name,
      };
    }
  } else {
    selectedRelayServer = defaultRelaySelection;
    selectedRelayAccount = defaultRelaySelection;
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
  if (selectedPipeline && unparsedPipelines !== undefined) {
    const parsedPipeline = parsePipelineName(unparsedPipelines[selectedPipeline].name);
    selectedInputMode = {
      value: parsedPipeline.format,
      label: parsedPipeline.format?.split(' ')[0].toUpperCase(),
    };

    selectedEncoder = {
      value: parsedPipeline.encoder,
      label: parsedPipeline.encoder?.toUpperCase(),
    };

    selectedResolution = {
      value: parsedPipeline.resolution,
      label: parsedPipeline.resolution ?? undefined,
    };

    selectedFramerate = {
      value: parsedPipeline.fps,
      label: parsedPipeline.fps?.toString() ?? undefined,
    };
  }
});

$effect(() => {
  if (
    groupedPipelines &&
    selectedInputMode?.value &&
    selectedEncoder?.value &&
    selectedResolution?.value &&
    selectedFramerate?.value
  ) {
    selectedPipeline = groupedPipelines[selectedInputMode.value][selectedEncoder.value][selectedResolution.value]?.find(
      pipeline => {
        return pipeline.extraction.fps === selectedFramerate?.value;
      },
    )?.identifier;
    areThereChanges =
      selectedPipeline !== undefined &&
      (initialSelectedPipeline !== selectedPipeline || initialSelectedBitrate !== selectedBitrate);
  } else {
    areThereChanges = false;
    selectedPipeline = undefined;
  }
});

// Auto-select logic for encoding settings
function autoSelectNextOption(currentLevel: string) {
  if (!groupedPipelines) return;

  switch (currentLevel) {
    case 'inputMode':
      if (selectedInputMode?.value) {
        // If there's only one encoding format option, auto-select it
        const encoders = Object.keys(groupedPipelines[selectedInputMode.value]);
        if (encoders.length === 1) {
          selectedEncoder = {
            value: encoders[0],
            label: encoders[0].toUpperCase(),
          };
          // Continue chain to next level
          autoSelectNextOption('encoder');
        }
      }
      break;

    case 'encoder':
      if (selectedInputMode?.value && selectedEncoder?.value) {
        // If there's only one resolution option, auto-select it
        const resolutions = Object.keys(groupedPipelines[selectedInputMode.value][selectedEncoder.value]);
        if (resolutions.length === 1) {
          selectedResolution = {
            value: resolutions[0],
            label: resolutions[0],
          };
          // Continue chain to next level
          autoSelectNextOption('resolution');
        }
      }
      break;

    case 'resolution':
      if (selectedInputMode?.value && selectedEncoder?.value && selectedResolution?.value) {
        // If there's only one framerate option, auto-select it
        const framerates = groupedPipelines[selectedInputMode.value][selectedEncoder.value][selectedResolution.value];
        if (framerates.length === 1) {
          selectedFramerate = {
            value: framerates[0].extraction.fps,
            label: framerates[0].extraction.fps?.toString(),
          };
        }
      }
      break;
  }
}

// Update functions
const updateMaxBitrate = () => {
  updateBitrate(selectedBitrate);
};

function validateForm() {
  formErrors = {};

  if (!selectedPipeline) {
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
  if (selectedPipeline) {
    config.pipeline = selectedPipeline;
  }
  const pipelineData = unparsedPipelines![selectedPipeline!]!;
  if (pipelineData.asrc) {
    config.asrc = selectedAudioSource!.value!;
  }
  if (pipelineData.acodec) {
    config.acodec = selectedAudioCodec!.value!;
  }
  if ((selectedRelayServer?.value == '-1' || selectedRelayServer?.value === undefined) && srtlaServerAddress) {
    config.srtla_addr = srtlaServerAddress;
  } else {
    config.relay_server = selectedRelayServer!.value;
  }
  if (srtLatency !== undefined) {
    config.srt_latency = srtLatency;
  }

  if (selectedRelayAccount?.value == '-1' || selectedRelayAccount?.value === undefined) {
    if (srtlaServerPort !== undefined) {
      config.srtla_port = srtlaServerPort;
    }
    config.srt_streamid = srtStreamId ?? '';
  } else {
    config.relay_account = selectedRelayAccount!.value;
  }
  config.delay = selectedAudioDelay;
  config.max_br = selectedBitrate!;

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
      <Card.Root class="md:row-span-2">
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('settings.encoderSettings')}</Card.Title>
          <Binary class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div class="grid gap-4">
            <!-- Input Mode Selection -->
            <div class="grid gap-1">
              <Label for="inputMode" class="mb-2">{$_('settings.inputMode')}</Label>
              <Select.Root
                disabled={isStreaming}
                selected={selectedInputMode}
                onSelectedChange={value => {
                  selectedEncoder = { value: undefined, label: undefined };
                  selectedResolution = { value: undefined, label: undefined };
                  selectedFramerate = { value: undefined, label: undefined };
                  selectedInputMode = value;

                  // Auto-select the next level if there's only one option
                  if (value) {
                    autoSelectNextOption('inputMode');
                  }
                }}>
                <Select.Trigger id="inputMode">
                  <Select.Value placeholder={$_('settings.selectInputMode')}></Select.Value>
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
              {#if selectedInputMode?.value && selectedInputMode.value.toLowerCase().includes('usb')}
                <p class="mt-1 text-xs text-muted-foreground">
                  {$_('settings.djiCameraMessage')}
                </p>
              {/if}
            </div>

            <!-- Encoding Format Selection -->
            <div class="grid gap-1">
              <Label for="encodingFormat" class="mb-2">{$_('settings.encodingFormat')}</Label>
              <Select.Root
                disabled={isStreaming || !selectedInputMode?.value}
                selected={selectedEncoder}
                onSelectedChange={value => {
                  selectedEncoder = value;
                  selectedResolution = { value: undefined, label: undefined };
                  selectedFramerate = { value: undefined, label: undefined };

                  // Auto-select the next level if there's only one option
                  if (value) {
                    autoSelectNextOption('encoder');
                  }
                }}>
                <Select.Trigger id="encodingFormat">
                  <Select.Value placeholder={$_('settings.selectEncodingOutputFormat')}></Select.Value>
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if selectedInputMode?.value && groupedPipelines?.[selectedInputMode.value]}
                      {#each Object.keys(groupedPipelines[selectedInputMode.value]) as encoder}
                        <Select.Item value={encoder} label={encoder.toUpperCase()}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </div>

            <!-- Encoding Resolution Selection -->
            <div class="grid gap-1">
              <Label for="encodingResolution" class="mb-2">{$_('settings.encodingResolution')}</Label>
              <Select.Root
                disabled={isStreaming || !selectedEncoder?.value}
                selected={selectedResolution}
                onSelectedChange={value => {
                  selectedResolution = value;
                  selectedFramerate = { value: undefined, label: undefined };

                  // Auto-select the next level if there's only one option
                  if (value) {
                    autoSelectNextOption('resolution');
                  }
                }}>
                <Select.Trigger id="encodingResolution">
                  <Select.Value placeholder={$_('settings.selectEncodingResolution')}></Select.Value>
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if selectedEncoder?.value && selectedInputMode?.value && groupedPipelines?.[selectedInputMode.value]?.[selectedEncoder.value]}
                      {@const resolutions = Object.keys(
                        groupedPipelines[selectedInputMode.value][selectedEncoder.value],
                      )}
                      {@const sortedResolutions = [...resolutions].sort((a, b) => {
                        // Put "match device resolution" or similar special options first
                        if (a.toLowerCase().includes('match') || a.toLowerCase().includes('device')) return -1;
                        if (b.toLowerCase().includes('match') || b.toLowerCase().includes('device')) return 1;

                        // Extract numeric values (like "720" from "720p")
                        const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
                        const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);

                        // Sort by numeric value
                        return numA - numB;
                      })}
                      {#each sortedResolutions as resolution}
                        <Select.Item value={resolution} label={resolution}></Select.Item>
                      {/each}
                    {/if}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </div>

            <!-- Framerate Selection -->
            <div class="grid gap-1">
              <Label for="framerate" class="mb-2">{$_('settings.framerate')}</Label>
              <Select.Root
                disabled={isStreaming || !selectedResolution?.value}
                selected={selectedFramerate}
                onSelectedChange={value => (selectedFramerate = value)}>
                <Select.Trigger id="framerate">
                  <Select.Value placeholder={$_('settings.selectFramerate')}></Select.Value>
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#if selectedEncoder?.value && selectedInputMode?.value && selectedResolution?.value && groupedPipelines?.[selectedInputMode.value]?.[selectedEncoder.value][selectedResolution.value]}
                      {@const framerates =
                        groupedPipelines[selectedInputMode.value][selectedEncoder.value][selectedResolution.value]}
                      {@const sortedFramerates = [...framerates].sort((a, b) => {
                        // Put "match device output" or similar special options first
                        const fpsA = a.extraction.fps;
                        const fpsB = b.extraction.fps;

                        if (typeof fpsA === 'string' && fpsA.toLowerCase().includes('match')) return -1;
                        if (typeof fpsB === 'string' && fpsB.toLowerCase().includes('match')) return 1;

                        // Convert to numbers for numeric comparison
                        const numA = typeof fpsA === 'number' ? fpsA : parseFloat(String(fpsA)) || 0;
                        const numB = typeof fpsB === 'number' ? fpsB : parseFloat(String(fpsB)) || 0;

                        // Sort by numeric value
                        return numA - numB;
                      })}
                      {#each sortedFramerates as framerate}
                        <Select.Item value={framerate.extraction.fps} label={framerate.extraction.fps?.toString()}
                        ></Select.Item>
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
                  id="bitrate"
                  class="mb-2 mt-2"
                  value={[selectedBitrate]}
                  max={12000}
                  min={500}
                  step={50}
                  onValueChange={value => {
                    setTimeout(() => {
                      selectedBitrate = value[0];
                      updateMaxBitrate();
                    });
                  }} />
                <Input
                  type="number"
                  step="50"
                  max={12000}
                  min={500}
                  bind:value={selectedBitrate}
                  onblur={() => {
                    selectedBitrate = normalizeValue(selectedBitrate, 2000, 12000, 50);
                    updateMaxBitrate();
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
          <Volume class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div class="grid gap-4">
            {#if audioCodecs && unparsedPipelines && selectedPipeline && unparsedPipelines[selectedPipeline].asrc}
              <div class="grid gap-1">
                <Label for="audioSource" class="mb-2">{$_('settings.audioSource')}</Label>
                <Select.Root
                  disabled={isStreaming}
                  selected={selectedAudioSource}
                  onSelectedChange={value => (selectedAudioSource = value)}>
                  <Select.Trigger id="audioSource">
                    <Select.Value placeholder={$_('settings.selectAudioSource')}></Select.Value>
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      {#if audioSources}
                        {#each audioSources as audioSource}
                          <Select.Item value={audioSource} label={audioSource}></Select.Item>
                        {/each}
                      {/if}
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if audioCodecs && unparsedPipelines && selectedPipeline && unparsedPipelines[selectedPipeline].acodec}
              <div class="grid gap-1">
                <Label for="audioCodec" class="mb-2">{$_('settings.audioCodec')}</Label>
                <Select.Root
                  disabled={isStreaming}
                  selected={selectedAudioCodec}
                  onSelectedChange={value => (selectedAudioCodec = value)}>
                  <Select.Trigger id="audioCodec">
                    <Select.Value placeholder={$_('settings.selectAudioCodec')}></Select.Value>
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
                    id="audioDelay"
                    class="mb-2 mt-2"
                    value={[selectedAudioDelay]}
                    onValueChange={value => (selectedAudioDelay = value[0])}
                    disabled={isStreaming}
                    max={2000}
                    min={-2000}
                    step={5}></Slider>
                  <Input
                    id="audioDelayInput"
                    bind:value={selectedAudioDelay}
                    type="number"
                    step="5"
                    min="-2000"
                    max="2000"
                    disabled={isStreaming}
                    onblur={() => {
                      selectedAudioDelay = normalizeValue(selectedAudioDelay, 2000, 12000, 50);
                    }}></Input>
                </div>
              </div>
            {/if}

            {#if audioCodecs && unparsedPipelines && selectedPipeline && !unparsedPipelines[selectedPipeline].acodec && !unparsedPipelines[selectedPipeline].asrc}
              <div class="mt-2">
                <h3>{$_('settings.noAudioSettingSupport')}</h3>
              </div>
            {/if}

            {#if audioCodecs && unparsedPipelines && !selectedPipeline}
              <div class="mt-2">
                <h3>{$_('settings.audioSettingsMessage')}</h3>
              </div>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('settings.receiverServer')}</Card.Title>
          <ServerIcon class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div class="grid gap-4">
            <div class="grid gap-1">
              <Label for="relayServer">{$_('settings.relayServer')}</Label>
              <Select.Root
                selected={selectedRelayServer}
                disabled={relayMessage === undefined || isStreaming}
                onSelectedChange={value => value && (selectedRelayServer = value)}>
                <Select.Trigger id="relayServer">
                  <Select.Value></Select.Value>
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

            {#if selectedRelayServer?.value === '-1' || selectedRelayServer?.value === undefined}
              <div class="grid gap-1">
                <Label for="srtlaServerAddress">{$_('settings.srtlaServerAddress')}</Label>
                <Input id="srtlaServerAddress" bind:value={srtlaServerAddress} disabled={isStreaming}></Input>
              </div>
            {/if}

            {#if selectedRelayServer?.value !== '-1' && selectedRelayServer?.value !== undefined}
              <div class="grid gap-1">
                <Label for="relayServerAccount">{$_('settings.relayServerAccount')}</Label>
                <Select.Root
                  selected={selectedRelayAccount}
                  disabled={relayMessage === undefined || isStreaming}
                  onSelectedChange={value => value && (selectedRelayAccount = value)}>
                  <Select.Trigger id="relayServerAccount">
                    <Select.Value></Select.Value>
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

            {#if selectedRelayAccount?.value === '-1' || selectedRelayAccount?.value === undefined}
              <div class="grid gap-1">
                <Label for="srtlaServerPort">{$_('settings.srtlaServerPort')}</Label>
                <Input id="srtlaServerPort" type="number" bind:value={srtlaServerPort} disabled={isStreaming}></Input>
              </div>
              <div class="grid gap-1">
                <Label for="srtStreamId">{$_('settings.srtStreamId')}</Label>
                <Input id="srtStreamId" bind:value={srtStreamId} disabled={isStreaming}></Input>
              </div>
            {/if}

            {#if srtLatency !== undefined}
              <div class="grid gap-1">
                <Label for="srtLatency">{$_('settings.srtLatency')}</Label>
                <Slider
                  id="srtLatency"
                  class="mb-2 mt-2"
                  value={[srtLatency]}
                  max={12000}
                  min={2000}
                  step={50}
                  onValueChange={value => (srtLatency = value[0])}
                  disabled={isStreaming}></Slider>
                <Input
                  id="srtLatencyInput"
                  type="number"
                  step="1"
                  bind:value={srtLatency}
                  disabled={isStreaming}
                  onblur={() => {
                    srtLatency = normalizeValue(srtLatency, 2000, 12000, 50);
                  }}></Input>
              </div>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
</div>
