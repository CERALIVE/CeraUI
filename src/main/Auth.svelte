<script lang="ts">
import { AlertCircle, CheckCircle, Eye, EyeOff, LoaderCircle, Shield } from '@lucide/svelte';
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
let showPassword: boolean = $state(false);

let isLoading = $state(false);
let setPassword: boolean = $state(false);

// Enhanced validation
const validation = $derived({
  password: {
    isValid: password.length >= (setPassword ? 8 : 1),
    isEmpty: password.length === 0,
    message: setPassword && password.length < 8 && password.length > 0 ? $_('auth.validation.passwordMinLength') : '',
  },
});

const isFormValid = $derived(validation.password.isValid);

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
      <div class="flex flex-col space-y-4 text-center">
        <!-- Enhanced Header with Icon -->
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg">
          <Shield class="h-8 w-8 text-white" />
        </div>

        <div class="space-y-2">
          <h1 class="text-2xl font-bold tracking-tight">
            {setPassword ? $_('auth.createPasswordAndLogin') : $_('auth.loginWithPassword')}
          </h1>
          <p class="text-muted-foreground text-sm leading-relaxed">{$_('auth.usePassword')}</p>
        </div>
      </div>
      <div class={cn('grid gap-6', className)}>
        <form onsubmit={onSubmit}>
          <div class="grid gap-4">
            <!-- Enhanced Password Field -->
            <div class="space-y-3">
              <Label for="password" class="text-foreground flex items-center gap-3 text-base font-semibold">
                <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                  <Shield class="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                {setPassword ? $_('auth.newPassword') : $_('auth.password')}
              </Label>

              <div class="relative">
                <Input
                  bind:value={password}
                  id="password"
                  placeholder={setPassword ? $_('auth.placeholderNewPassword') : $_('auth.placeholderPassword')}
                  type={showPassword ? 'text' : 'password'}
                  class={cn(
                    'focus:ring-opacity-20 h-12 w-full rounded-xl border-2 px-4 pr-12 text-base transition-all duration-300 focus:ring-4',
                    !validation.password.isValid && !validation.password.isEmpty
                      ? 'border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-500 dark:bg-red-950/20'
                      : validation.password.isValid && !validation.password.isEmpty
                        ? 'border-green-400 bg-green-50 focus:border-green-500 focus:ring-green-500 dark:bg-green-950/20'
                        : 'border-gray-200 bg-gray-50 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800/50',
                  )}
                  autocapitalize="none"
                  autocomplete={setPassword ? 'new-password' : 'current-password'}
                  autocorrect="off"
                  disabled={isLoading} />

                <!-- Password Visibility Toggle -->
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="absolute top-1/2 right-1 h-10 w-10 -translate-y-1/2 hover:bg-gray-100 dark:hover:bg-gray-800"
                  onclick={() => (showPassword = !showPassword)}>
                  {#if showPassword}
                    <EyeOff class="h-4 w-4 text-gray-500" />
                  {:else}
                    <Eye class="h-4 w-4 text-gray-500" />
                  {/if}
                </Button>

                <!-- Validation Icon -->
                {#if !validation.password.isEmpty}
                  <div class="absolute top-1/2 right-12 -translate-y-1/2">
                    {#if validation.password.isValid}
                      <CheckCircle class="h-5 w-5 text-green-500" />
                    {:else}
                      <AlertCircle class="h-5 w-5 text-red-500" />
                    {/if}
                  </div>
                {/if}
              </div>

              <!-- Validation Messages -->
              {#if validation.password.message}
                <div class="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle class="h-4 w-4" />
                  <span>{validation.password.message}</span>
                </div>
              {:else if setPassword && validation.password.isValid}
                <div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle class="h-4 w-4" />
                  <span>{$_('auth.validation.passwordValid')}</span>
                </div>
              {/if}
            </div>

            <!-- Enhanced Submit Button -->
            <Button
              type="submit"
              disabled={isLoading || !isFormValid}
              class="h-12 w-full rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-base font-semibold text-white shadow-lg transition-all duration-300 hover:from-blue-700 hover:to-purple-700 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50">
              {#if isLoading}
                <LoaderCircle class="mr-2 h-5 w-5 animate-spin" />
                <span>{setPassword ? $_('auth.creatingPassword') : $_('auth.signingIn')}</span>
              {:else}
                <Shield class="mr-2 h-5 w-5" />
                <span>{setPassword ? $_('auth.createPassword') : $_('auth.signIn')}</span>
              {/if}
            </Button>
          </div>
          <!-- Enhanced Remember Me -->
          <div class="mt-4 flex items-center space-x-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
            <Checkbox id="remember" bind:checked={remember} class="h-5 w-5" />
            <Label
              for="remember"
              class="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              {$_('auth.rememberMe')}
            </Label>
          </div>
        </form>

        <!-- Enhanced Divider -->
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <span class="w-full border-t border-gray-200 dark:border-gray-700"></span>
          </div>
          <div class="relative flex justify-center text-xs uppercase">
            <span class="bg-background text-muted-foreground px-4 font-medium"> {siteName}</span>
          </div>
        </div>

        <!-- Enhanced Help Section -->
        {#if setPassword}
          <div class="rounded-lg bg-blue-50 p-4 dark:bg-blue-950/20">
            <div class="flex items-start gap-3">
              <Shield class="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
              <div class="space-y-1">
                <h3 class="text-sm font-semibold text-blue-800 dark:text-blue-200">
                  {$_('auth.help.createPasswordTitle')}
                </h3>
                <p class="text-xs leading-relaxed text-blue-700 dark:text-blue-300">
                  {$_('auth.help.createPasswordDescription')}
                </p>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Enhanced Footer -->
      <div class="space-y-2 text-center">
        <p class="text-muted-foreground text-sm">{$_('auth.footerText')}</p>
        <p class="text-muted-foreground/70 text-xs">{siteName} Beta UI - {$_('auth.secureAccess')}</p>
      </div>
    </div>
  </div>
</div>
