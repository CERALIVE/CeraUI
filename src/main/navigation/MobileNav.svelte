<script lang="ts">
import { Menu } from '@lucide/svelte';
import { scale } from 'svelte/transition';
import { _ } from 'svelte-i18n';

import Logo from '$lib/components/icons/Logo.svelte';
import { Button } from '$lib/components/ui/button';
import MobileLink from '$lib/components/ui/mobile-link.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import * as Sheet from '$lib/components/ui/sheet';
import { defaultNavElement, type NavElements, navElements, siteName } from '$lib/config';
import { navigationStore } from '$lib/stores/navigation';

let currentNav: NavElements = $state(defaultNavElement);
let open = $state(false);

const handleClick = (nav: NavElements) => {
  navigationStore.set(nav);
  open = false;
};

// Subscribe to navigation changes (hash navigation is handled centrally in NavigationRenderer)
$effect(() => {
  const unsubscribe = navigationStore.subscribe(navigation => {
    currentNav = navigation;
  });

  return unsubscribe;
});
</script>

<Sheet.Root bind:open>
  <Sheet.Trigger>
    <Button
      variant="ghost"
      class="group hover:bg-accent/50 focus-visible:bg-accent/50 relative mr-2 rounded-xl px-3 py-2 text-base transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0 md:hidden">
      <Menu class="h-5 w-5 transition-transform duration-200 group-hover:scale-110" />
      <span class="sr-only">{$_('navigation.toggleMenu')}</span>

      <!-- Subtle glow effect on hover -->
      <div
        class="bg-primary/10 absolute -inset-1 rounded-xl opacity-0 blur-sm transition-opacity duration-200 group-hover:opacity-100">
      </div>
    </Button>
  </Sheet.Trigger>
  <Sheet.Content side="left" class="pt-6 pr-0">
    <!-- Clean Header Section -->
    <div class="border-border/50 border-b px-6 pb-6">
      <button
        class="group hover:bg-accent/50 flex w-full items-center space-x-3 rounded-xl px-4 py-3 transition-all duration-200"
        onclick={() => handleClick(defaultNavElement)}>
        <!-- Logo -->
        <Logo class="h-6 w-6 transition-transform duration-200 group-hover:scale-105" />

        <!-- Clean brand name -->
        <span class="text-foreground text-lg font-semibold">
          {siteName}
        </span>
      </button>
    </div>
    <!-- Enhanced Navigation Links Section -->
    <ScrollArea orientation="both" class="flex-1 px-6 pt-6">
      <div class="flex flex-col space-y-2 pb-10">
        {#each Object.entries(navElements) as [identifier, navigation]}
          {@const isActive = currentNav && Object.keys(currentNav)[0] === identifier}
          {#if identifier}
            <div
              class="relative"
              in:scale={{ duration: 200, delay: Object.keys(navElements).indexOf(identifier) * 50 }}>
              <MobileLink {identifier} {isActive} onclick={() => handleClick({ [identifier]: navigation })}>
                {$_(`navigation.${navigation.label}`)}
              </MobileLink>
            </div>
          {/if}
        {/each}
      </div>
    </ScrollArea>
  </Sheet.Content>
</Sheet.Root>
