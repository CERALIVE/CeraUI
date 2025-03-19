<script lang="ts">
import { onMount } from 'svelte';
import { cubicInOut } from 'svelte/easing';
import { crossfade } from 'svelte/transition';
import { _ } from 'svelte-i18n';

import { Icons } from '$lib/components/icons';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import { defaultNavElement, type NavElements, navElements, siteName } from '$lib/config';
import { setupHashNavigation } from '$lib/helpers/NavigationHelper';
import { navigationStore } from '$lib/stores/navigation';
import { cn } from '$lib/utils';

const [send, receive] = crossfade({
  duration: 250,
  easing: cubicInOut,
});

let currentNav: NavElements | undefined = $state(defaultNavElement);

onMount(() => {
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

<div class="mr-4 hidden md:flex">
  <button class="mr-6 flex items-center space-x-2" onclick={() => navigationStore.set(defaultNavElement)}>
    <Icons.logo class="h-6 w-6" />
    <span class="hidden font-bold xl:inline-block">
      {siteName}
    </span>
  </button>
  <ScrollArea orientation="both" scrollbarXClasses="invisible">
    <div class="m-4 flex items-center overflow-y-auto pb-3 md:pb-0">
      {#each Object.entries(navElements) as [identifier, navigation]}
        {@const isActive = currentNav && Object.keys(currentNav)[0] === identifier}
        <button
          onclick={() => navigationStore.set({ [identifier]: navigation })}
          id={identifier}
          class={cn(
            'relative flex h-9 min-w-36 items-center justify-center rounded-b-2xl px-4 text-center text-sm transition-colors hover:text-primary',
            isActive ? 'font-medium text-primary' : 'text-muted-foreground',
          )}>
          {#if isActive}
            <div
              class="absolute inset-0 rounded-2xl bg-muted"
              in:send={{ key: 'activetab' }}
              out:receive={{ key: 'activetab' }}>
            </div>
          {/if}
          <span class="relative">
            {$_(`navigation.${navigation.label}`)}
          </span>
        </button>
      {/each}
    </div>
  </ScrollArea>
</div>
