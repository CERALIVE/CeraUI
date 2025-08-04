<script lang="ts">
import { LoaderCircle } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import { Button } from '$lib/components/ui/button';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import LocaleSelector from '$lib/components/ui/locale-selector.svelte';
import ModeToggle from '$lib/components/ui/mode-toggle.svelte';
import { siteName } from '$lib/config';
import {
  AuthMessages,
  NotificationsMessages,
  sendAuthMessage,
  sendCreatePasswordMessage,
  StatusMessages,
} from '$lib/stores/websocket-store';
import { cn } from '$lib/utils.js';

let className: string | undefined | null = $state(undefined);
export { className as class };

let password: string = $state('');
let remember: boolean = $state(false);

let isLoading = $state(false);
let setPassword: boolean = $state(false);

StatusMessages.subscribe(status => {
  if (status) {
    setPassword = status.set_password ?? false;
    if (setPassword) {
      localStorage.removeItem('auth');
    }
  }
});

AuthMessages.subscribe(message => {
  if (message?.success && remember && password) {
    localStorage.setItem('auth', password);
  }
});

NotificationsMessages.subscribe(messages => {
  if (
    messages?.show?.find(message => {
      return message.name === 'auth';
    })
  ) {
    isLoading = false;
    localStorage.removeItem('auth');
  }
});

function login(password: string, remember: boolean) {
  isLoading = true;
  if (setPassword) {
    setPassword = false;
    sendCreatePasswordMessage(password);
  }
  sendAuthMessage(password, remember, () => (isLoading = false));
}

async function onSubmit(event: SubmitEvent) {
  event.preventDefault();
  login(password, remember);
}
</script>

<div class="relative container grid h-dvh flex-col items-center justify-center lg:max-w-none lg:grid-cols-2 lg:px-0">
  <span class="absolute top-4 right-4 flex md:top-8 md:right-8">
    <span class="mr-3"> <LocaleSelector /></span>
    <ModeToggle></ModeToggle>
  </span>
  <div class="bg-muted relative hidden h-full flex-col p-10 text-white lg:flex dark:border-r">
    <div
      class="absolute inset-0 bg-cover"
      style="
				background-image:
					url(https://images.unsplash.com/photo-1590069261209-f8e9b8642343?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1376&q=80);">
    </div>
    <div class="relative z-20 flex items-center text-lg font-medium">
      <!-- <Command class="mr-2 h-6 w-6" /> -->
      {siteName} Beta UI
    </div>
    <div class="relative z-20 mt-auto">
      <blockquote class="space-y-2">
        <p class="text-lg">&ldquo;The revolution of IRL...&rdquo;</p>
        <footer class="text-sm"></footer>
      </blockquote>
    </div>
  </div>
  <div class="lg:p-8">
    <div class="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div class="flex flex-col space-y-2 text-center">
        <h1 class="text-2xl font-semibold tracking-tight">
          {setPassword ? $_('auth.createPasswordAndLogin') : $_('auth.loginWithPassword')}
        </h1>
        <p class="text-muted-foreground text-sm">{$_('auth.usePassword')}</p>
      </div>
      <div class={cn('grid gap-6', className)}>
        <form onsubmit={onSubmit}>
          <div class="grid gap-2">
            <div class="grid gap-1">
              <Input
                bind:value={password}
                id="password"
                placeholder="*******"
                type="password"
                autocapitalize="none"
                autocomplete="off"
                autocorrect="off"
                disabled={isLoading} />
            </div>
            <Button type="submit" disabled={isLoading}>
              {#if isLoading}
                <LoaderCircle class="mr-2 h-4 w-4 animate-spin" />
              {/if}
              Sign In
            </Button>
          </div>
          <div class="mt-3 flex items-center space-x-2">
            <Checkbox id="remember" bind:checked={remember} />
            <Label
              for="remember"
              class="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              {$_('auth.rememberMe')}
            </Label>
          </div>
        </form>

        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <span class="w-full border-t"></span>
          </div>
          <div class="relative flex justify-center text-xs uppercase">
            <span class="bg-background text-muted-foreground px-2"> {siteName}</span>
          </div>
        </div>
      </div>
      <p class="text-muted-foreground px-8 text-center text-sm">{$_('auth.footerText')}</p>
    </div>
  </div>
</div>
