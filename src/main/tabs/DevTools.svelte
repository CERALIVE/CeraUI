<style>
/* Dev tools specific styling */
:global(.dev-highlight) {
  position: relative;
  overflow: hidden;
}

:global(.dev-highlight::before) {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.1), transparent);
  animation: dev-sweep 3s infinite;
}

@keyframes dev-sweep {
  0% {
    left: -100%;
  }
  50% {
    left: 100%;
  }
  100% {
    left: 100%;
  }
}
</style>

<script lang="ts">
import { Bug, Wrench } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import DemoOverlayTrigger from '$lib/components/demo-overlay-trigger.svelte';
import SystemInfo from '$lib/components/dev-tools/system-info.svelte';
import ToastTester from '$lib/components/dev-tools/toast-tester.svelte';
import * as Card from '$lib/components/ui/card';
import { BUILD_INFO } from '$lib/env';

// Development environment info
const isDev = BUILD_INFO.IS_DEV;
</script>

<!-- Dev Tools Page -->
<div class="from-background via-background to-accent/5 min-h-screen bg-gradient-to-br">
  <div class="container mx-auto max-w-7xl px-4 py-6">
    <!-- Header Section -->
    <div class="mb-8">
      <div class="mb-4 flex items-center gap-3">
        <div
          class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500">
          <Wrench class="h-6 w-6 text-white" />
        </div>
        <div>
          <h1 class="text-3xl font-bold tracking-tight">🛠️ {$_('devtools.title')}</h1>
          <p class="text-muted-foreground mt-1">{$_('devtools.description')}</p>
        </div>
      </div>

      <!-- Dev Mode Badge -->
      <div
        class="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-100 px-3 py-1 text-sm dark:border-amber-800 dark:bg-amber-900/20">
        <div class="h-2 w-2 animate-pulse rounded-full bg-amber-500"></div>
        <span class="font-medium text-amber-700 dark:text-amber-300">
          {$_('devtools.developmentMode')}: {BUILD_INFO.MODE} | {$_('devtools.status')}: {$_('devtools.active')}
        </span>
      </div>
    </div>

    <!-- Grid Layout -->
    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Component Testing Section -->
      <div class="space-y-6">
        <!-- Overlay Demo Card -->
        <DemoOverlayTrigger />

        <!-- Toast Notification Tester -->
        <ToastTester />
      </div>

      <!-- Debug Information Section -->
      <div class="space-y-6">
        <!-- Real System Information -->
        <SystemInfo />

        <!-- Debug Tools Card -->
        <Card.Root class="border-dashed border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20">
          <Card.Header>
            <Card.Title class="flex items-center gap-2 text-red-700 dark:text-red-300">
              <Bug class="h-5 w-5" />
              🐛 {$_('devtools.consoleTesting')}
            </Card.Title>
            <Card.Description class="text-red-600 dark:text-red-400">
              {$_('devtools.consoleTestingDesc')}
            </Card.Description>
          </Card.Header>

          <Card.Content class="space-y-3">
            <div class="bg-muted/30 rounded-md p-3">
              <div class="mb-2 text-xs font-medium">{$_('devtools.consoleOutputTests')}</div>
              <div class="flex flex-wrap gap-2">
                <button
                  class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
                  onclick={() => console.log('✅ Console log test:', { timestamp: new Date(), level: 'info' })}>
                  {$_('devtools.log')}
                </button>
                <button
                  class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
                  onclick={() => console.warn('⚠️ Console warning test:', { timestamp: new Date(), level: 'warn' })}>
                  {$_('devtools.warn')}
                </button>
                <button
                  class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
                  onclick={() => console.error('❌ Console error test:', { timestamp: new Date(), level: 'error' })}>
                  {$_('devtools.error')}
                </button>
                <button
                  class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
                  onclick={() =>
                    console.table({
                      browser: navigator.userAgent.split(' ')[0],
                      language: navigator.language,
                      online: navigator.onLine,
                    })}>
                  {$_('devtools.table')}
                </button>
              </div>
            </div>
          </Card.Content>
        </Card.Root>
      </div>
    </div>

    <!-- Warning Footer -->
    <div class="mt-12 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/20">
      <div class="flex items-start gap-3">
        <div class="mt-0.5 h-5 w-5 text-amber-600 dark:text-amber-400">⚠️</div>
        <div class="flex-1">
          <div class="text-sm font-medium text-amber-800 dark:text-amber-200">{$_('devtools.developmentOnly')}</div>
          <div class="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {$_('devtools.developmentOnlyDesc')}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
