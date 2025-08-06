<script lang="ts">
import { cubicInOut } from 'svelte/easing';
import { crossfade, scale } from 'svelte/transition';
import { _ } from 'svelte-i18n';

import Logo from '$lib/components/icons/Logo.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import { defaultNavElement, type NavElements, navElements, siteName } from '$lib/config';
import { setupHashNavigation } from '$lib/helpers/NavigationHelper';
import { navigationStore } from '$lib/stores/navigation';
import { cn } from '$lib/utils';

const [send, receive] = crossfade({
  duration: 300,
  easing: cubicInOut,
});

let currentNav: NavElements | undefined = $state(defaultNavElement);

// Setup navigation using reactive effect instead of onMount [[memory:5293956]]
$effect(() => {
  // Setup hash-based navigation
  const cleanup = setupHashNavigation(navigationStore);

  // Local subscription to update currentNav
  const unsubscribe = navigationStore.subscribe(navigation => {
    currentNav = navigation;
  });

  return () => {
    cleanup();
    unsubscribe();
  };
});
</script>

<!-- Brand/Logo Section with Enhanced Design -->
<div class="mr-6 hidden md:flex">
  <button
    class="group hover:bg-accent/50 relative flex cursor-pointer items-center space-x-3 rounded-xl px-3 py-2 transition-all duration-200"
    onclick={() => navigationStore.set(defaultNavElement)}>
    <!-- Logo with glow effect -->
    <div class="relative">
      <Logo class="h-7 w-7 transition-transform duration-200 group-hover:scale-110" />
      <div
        class="bg-primary/20 absolute -inset-1 rounded-full opacity-0 blur-sm transition-opacity duration-200 group-hover:opacity-100">
      </div>
    </div>

    <!-- Brand name with clean typography -->
    <span class="text-foreground hidden font-bold tracking-tight xl:inline-block">
      {siteName}
    </span>
  </button>
</div>

<!-- Navigation Tabs with Modern Design -->
<div class="hidden flex-1 md:flex">
  <ScrollArea orientation="both" scrollbarXClasses="invisible">
    <div class="flex items-center space-x-1 px-4 py-2">
      {#each Object.entries(navElements) as [identifier, navigation]}
        {@const isActive = currentNav && Object.keys(currentNav)[0] === identifier}
        <button
          onclick={() => navigationStore.set({ [identifier]: navigation })}
          id={identifier}
          class={cn(
            'group relative flex h-10 min-w-28 cursor-pointer items-center justify-center rounded-xl px-4 text-center text-sm font-medium transition-all duration-200',
            isActive ? 'text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}>
          {#if isActive}
            <!-- Enhanced active indicator with gradient and shadow -->
            <div
              class="from-background to-accent border-border/50 absolute inset-0 rounded-xl border bg-gradient-to-b shadow-lg"
              in:send={{ key: 'activetab' }}
              out:receive={{ key: 'activetab' }}>
            </div>
            <!-- Subtle glow effect for active tab -->
            <div class="bg-primary/5 absolute inset-0 rounded-xl opacity-50"></div>
          {/if}

          <!-- Tab content with enhanced typography -->
          <span class="relative z-10 transition-all duration-200 group-hover:scale-105">
            {$_(`navigation.${navigation.label}`)}
          </span>

          <!-- Subtle hover indicator -->
          {#if !isActive}
            <div
              class="bg-primary/60 absolute bottom-0 left-1/2 h-0.5 w-0 transition-all duration-200 group-hover:w-8 group-hover:-translate-x-1/2">
            </div>
          {/if}
        </button>
      {/each}
    </div>
  </ScrollArea>
</div>
