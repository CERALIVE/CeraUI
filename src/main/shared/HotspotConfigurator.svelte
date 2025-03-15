<script lang="ts">
import { Bolt } from 'lucide-svelte';
import { _ } from 'svelte-i18n';
import type { ValueOf } from '$lib/types';
import type { StatusMessage } from '$lib/types/socket-messages';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import { type WifiBandNames, changeHotspotSettings } from '$lib/helpers/NetworkHelper';

const getSelectedChannel: () => { value: WifiBandNames; label: string } = () => {
  return {
    value: wifi.hotspot?.channel ?? 'auto',
    label: wifi.hotspot?.available_channels[wifi.hotspot?.channel].name ?? 'Auto',
  };
};

let { deviceId, wifi }: { deviceId: number; wifi: ValueOf<StatusMessage['wifi']> } = $props();
let hotspotProperties = $state({
  selectedChannel: getSelectedChannel(),
  password: wifi.hotspot?.password,
  deviceId,
  name: wifi.hotspot?.name,
});
const resetHotSpotProperties = () => {
  hotspotProperties = {
    selectedChannel: getSelectedChannel(),
    password: wifi.hotspot?.password,
    deviceId,
    name: wifi.hotspot?.name,
  };
};
</script>

<SimpleAlertDialog
  confirmButtonText={$_('hotspotConfigurator.dialog.save')}
  oncancel={() => resetHotSpotProperties()}
  title={$_('hotspotConfigurator.dialog.configHotspot')}
  extraButtonClasses="bg-green-500 hover:bg-green-500/90"
  disabledConfirmButton={!hotspotProperties?.password?.length || !hotspotProperties?.name?.length}
  onconfirm={() => {
    changeHotspotSettings({
      channel: hotspotProperties.selectedChannel.value ?? 'auto',
      deviceId: hotspotProperties.deviceId,
      name: hotspotProperties.name ?? '',
      password: hotspotProperties.password ?? '',
    });
  }}>
  {#snippet icon()}
    <Bolt></Bolt>
  {/snippet}
  {#snippet dialogTitle()}
    {$_('hotspotConfigurator.dialog.configureHotspot')}
  {/snippet}
  {#snippet description()}
    <div class="grid gap-2">
      <div class="grid gap-1">
        <Label for="name">{$_('hotspotConfigurator.hotspot.name')}</Label>
        <Input
          bind:value={hotspotProperties.name}
          id="name"
          placeholder={$_('hotspotConfigurator.hotspot.placeholderName')}
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off" />
      </div>
      <div class="grid gap-1">
        <Label for="hotspotPassword">{$_('hotspotConfigurator.hotspot.password')}</Label>
        <Input
          bind:value={hotspotProperties.password}
          id="hotspotPassword"
          type="password"
          placeholder={$_('hotspotConfigurator.hotspot.placeholderPassword')}
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off" />
      </div>
      <div class="grid gap-1">
        <Label for="channel">{$_('hotspotConfigurator.hotspot.channel')}</Label>
        <Select.Root
          onSelectedChange={selected => {
            if (hotspotProperties && selected !== undefined) hotspotProperties.selectedChannel = selected;
          }}
          selected={hotspotProperties.selectedChannel}>
          <Select.Trigger class="w-[180px]">
            <Select.Value placeholder={$_('hotspotConfigurator.hotspot.selectChannel')}></Select.Value>
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              {#if wifi.hotspot?.available_channels}
                {#each Object.entries(wifi.hotspot?.available_channels) as [channelId, channel]}
                  <Select.Item value={channelId}>
                    {channel.name}
                  </Select.Item>
                {/each}
              {/if}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  {/snippet}
</SimpleAlertDialog>
