<script lang="ts">
import { Eye, EyeOff, Hammer, Logs, PowerOff, RotateCcw } from 'lucide-svelte';
import Settings from 'lucide-svelte/icons/settings';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';
import type { RevisionsMessage } from '$lib/types/socket-messages';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import {
  getBelaboxLog,
  getSystemLog,
  powerOff,
  reboot,
  resetSSHPasword,
  savePassword,
  saveRemoteKey,
  startSSH,
  stopSSH,
} from '$lib/helpers/SystemHelper';
import { ConfigMessages, RevisionsMessages, StatusMessages } from '$lib/stores/websocket-store';
import { cn } from '$lib/utils';

let currentRemoteKey = $state('');
let remoteKey = $state('');

let showPassword = $state(false);
let showRemoteKey = $state(false);
let showSSHPassword = $state(false);

let password = $state('');
let sshPassword = $state('');
let sshStatus = $state(false);
let sshUser = $state('');
let sshPasswordChanged = $state(false);

ConfigMessages.subscribe(config => {
  currentRemoteKey = config?.remote_key ?? '';
  remoteKey = config?.remote_key ?? '';
});

let revisions = $state<RevisionsMessage | undefined>();
RevisionsMessages.subscribe(revisionMessage => {
  revisions = revisionMessage;
});

ConfigMessages.subscribe(configMessage => {
  if (sshPasswordChanged && configMessage.ssh_pass && sshPassword !== configMessage.ssh_pass) {
    toast.success($_('advanced.passwordCopied'), {
      description: $_('advanced.passwordCopiedDesc'),
    });
    sshPasswordChanged = false;
  }
  sshPassword = configMessage?.ssh_pass ?? '';
});
StatusMessages.subscribe(statusMessage => {
  sshStatus = statusMessage?.ssh.active ?? false;
  sshUser = statusMessage?.ssh.user ?? '';
});
</script>

<div class="flex-col md:flex">
  <div class="flex-1 space-y-4 p-8 pt-6">
    <div class="grid gap-4 md:grid-cols-7 lg:grid-cols-7">
      <!-- System Settings Card -->
      <Card.Root class="col-span-4 sm:col-span-4 md:col-span-4">
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">
            {$_('advanced.systemSettings')}
          </Card.Title>
          <Settings class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div>
            <div>
              <Label for="lanPassword">{$_('advanced.lanPassword')}</Label>
              {#if password.length < 8}
                <p class="text-xs text-red-500 my-1">{$_('advanced.minLength')}</p>
              {/if}
              <div class="relative">
                <Input
                  id="lanPassword"
                  bind:value={password}
                  type={showPassword ? 'text' : 'password'}
                  placeholder={$_('advanced.newPassword')} />
                <div class="absolute inset-y-0 right-0 flex items-center">
                  <Button
                    variant="outline"
                    class="rounded-r-none border-r-0"
                    on:click={() => (showPassword = !showPassword)}>
                    {#if showPassword}
                      <EyeOff></EyeOff>
                    {:else}
                      <Eye></Eye>
                    {/if}
                  </Button>
                  <Button
                    variant="outline"
                    class="rounded-l-none border-l-0 bg-red-600 hover:bg-red-700"
                    disabled={password.length < 8}
                    onclick={() => {
                      savePassword(password);
                      password = '';
                    }}>
                    {$_('advanced.save')}
                  </Button>
                </div>
              </div>
            </div>

            <div class="mt-2">
              <Label for="remoteKey">{$_('advanced.cloudRemoteKey')}</Label>
              <p>
                <a
                  class="block cursor-pointer text-sm font-medium text-blue-400 hover:underline"
                  href="https://cloud.belabox.net"
                  target="_blank"
                >
                  https://cloud.belabox.net
                </a>
              </p>
              <div class="relative">
                <Input id="remoteKey" name="remote-key" type={showRemoteKey ? 'text' : 'password'} bind:value={remoteKey} />
                <div class="absolute inset-y-0 right-0 flex">
                  <Button
                    variant="outline"
                    class="rounded-r-none border-r-0"
                    on:click={() => (showRemoteKey = !showRemoteKey)}>
                    {#if showRemoteKey}
                      <EyeOff></EyeOff>
                    {:else}
                      <Eye></Eye>
                    {/if}
                  </Button>
                  <Button
                    variant="outline"
                    class="rounded-l-none border-l-0 bg-red-600 hover:bg-red-700"
                    disabled={remoteKey === currentRemoteKey}
                    onclick={() => {
                      saveRemoteKey(remoteKey);
                    }}>
                    {$_('advanced.save')}
                  </Button>
                </div>
              </div>
            </div>

            <div class="mt-4 space-y-2">
              <SimpleAlertDialog
                buttonText={$_('advanced.reboot')}
                confirmButtonText={$_('advanced.reboot')}
                onconfirm={reboot}
                iconPosition="left"
                extraButtonClasses="bg-yellow-600 hover:bg-yellow-700 w-full flex-none">
                {#snippet icon()}
                  <RotateCcw></RotateCcw>
                {/snippet}
                {#snippet dialogTitle()}
                  {$_('advanced.reboot')}
                {/snippet}
                {#snippet description()}
                  {$_('advanced.confirmReboot')}
                {/snippet}
              </SimpleAlertDialog>
              <SimpleAlertDialog
                buttonText={$_('advanced.powerOff')}
                confirmButtonText={$_('advanced.powerOff')}
                onconfirm={powerOff}
                extraButtonClasses="w-full flex-none"
                iconPosition="left">
                {#snippet icon()}
                  <PowerOff></PowerOff>
                {/snippet}
                {#snippet dialogTitle()}
                  {$_('advanced.powerOff')}
                {/snippet}
                {#snippet description()}
                  {$_('advanced.confirmPowerOff')}
                {/snippet}
              </SimpleAlertDialog>
            </div>
          </div>
        </Card.Content>
        {#if revisions}
          <Card.Footer>
            <p class="text-xs">
              BelaUI: {revisions.belaUI} , Belacoder: {revisions.belacoder}, SRTLA: {revisions.srtla}, BELABOX Image: {revisions[
                'BELABOX image'
              ]}
            </p>
          </Card.Footer>
        {/if}
      </Card.Root>

      <!-- Developer Options Card -->
      <Card.Root class="col-span-4 sm:col-span-4 md:col-span-3">
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">
            {$_('advanced.developerOptions')}
          </Card.Title>
          <Hammer class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div>
            <div>
              <!-- SSH Password Section -->
              <Label for="sshPassword">
                {$_('advanced.sshPassword', { values: { sshUser } })}
              </Label>
              <div class="relative">
                <Input
                  id="sshPassword"
                  on:focus={event => {
                    event.preventDefault();
                    navigator.clipboard.writeText(sshPassword).then(() => {
                      toast.info($_('advanced.passwordCopied'), {
                        description: $_('advanced.passwordCopiedDesc'),
                      });
                    });
                    event.currentTarget?.blur();
                  }}
                  bind:value={sshPassword}
                  type={showSSHPassword ? 'text' : 'password'}
                  placeholder={$_('advanced.sshPasswordPlaceholder')} />
                <div class="absolute inset-y-0 right-0 flex items-center">
                  <Button
                    variant="outline"
                    class="rounded-r-none border-r-0"
                    on:click={() => (showSSHPassword = !showSSHPassword)}>
                    {#if showSSHPassword}
                      <EyeOff></EyeOff>
                    {:else}
                      <Eye></Eye>
                    {/if}
                  </Button>
                  <Button
                    variant="outline"
                    class="rounded-l-none border-l-0 bg-red-600 hover:bg-red-700"
                    onclick={() => {
                      resetSSHPasword();
                      sshPasswordChanged = true;
                    }}>
                    {$_('advanced.reset')}
                  </Button>
                </div>
              </div>
            </div>

            <div class="mt-4">
              <!-- SSH Toggle Button -->
              <Button
                class={cn(
                  sshStatus ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-green-600 hover:bg-green-700',
                  'mt-2 w-full flex-none',
                )}
                onclick={sshStatus ? stopSSH : startSSH}>
                {sshStatus ? $_('advanced.stopSSH') : $_('advanced.startSSH')}
              </Button>

              <SimpleAlertDialog
                buttonText={$_('advanced.belaboxLog')}
                confirmButtonText={$_('advanced.download')}
                onconfirm={getBelaboxLog}
                iconPosition="left"
                extraButtonClasses="bg-blue-600 hover:bg-blue-700 mt-2 w-full flex-none">
                {#snippet icon()}
                  <Logs></Logs>
                {/snippet}
                {#snippet dialogTitle()}
                  {$_('advanced.downloadBelaboxLog')}
                {/snippet}
                {#snippet description()}
                  {$_('advanced.confirmBelaboxLog')}
                {/snippet}
              </SimpleAlertDialog>
              <SimpleAlertDialog
                buttonText={$_('advanced.systemLog')}
                confirmButtonText={$_('advanced.download')}
                onconfirm={getSystemLog}
                extraButtonClasses="bg-blue-600 hover:bg-blue-700 mt-2 w-full flex-none"
                iconPosition="left">
                {#snippet icon()}
                  <Logs></Logs>
                {/snippet}
                {#snippet dialogTitle()}
                  {$_('advanced.downloadSystemLog')}
                {/snippet}
                {#snippet description()}
                  {$_('advanced.confirmSystemLog')}
                {/snippet}
              </SimpleAlertDialog>
            </div>
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
</div>
