<script lang="ts">
import { Menu } from '@lucide/svelte';
import { onMount } from 'svelte';
import { _ } from 'svelte-i18n';

import Logo from '$lib/components/icons/Logo.svelte';
import { Button } from '$lib/components/ui/button';
import MobileLink from '$lib/components/ui/mobile-link.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import * as Sheet from '$lib/components/ui/sheet';
import { defaultNavElement, type NavElements, navElements, siteName } from '$lib/config';
import { setupHashNavigation } from '$lib/helpers/NavigationHelper';
import { navigationStore } from '$lib/stores/navigation';

let currentNav: NavElements = $state(defaultNavElement);
let open = $state(false);

const handleClick = (nav: NavElements) => {
  navigationStore.set(nav);
  open = false;
};

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

<Sheet.Root bind:open>
  <Sheet.Trigger>
    <Button
      variant="ghost"
      class="mr-2 px-0 text-base hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 md:hidden">
      <Menu class="h-5! w-5!" />
      <span class="sr-only">Toggle Menu</span>
    </Button>
  </Sheet.Trigger>
  <Sheet.Content side="left" class="pr-0">
    <MobileLink identifier="general" class="flex items-center" onclick={() => handleClick(defaultNavElement)}>
      <Logo class="mr-2 h-4 w-4" />
      <span class="font-bold">{siteName}</span>
    </MobileLink>
    <ScrollArea orientation="both" class="my-4 h-[calc(100vh-8rem)] pb-10">
      <div class="flex flex-col space-y-3 pr-6">
        {#each Object.entries(navElements) as [identifier, navigation]}
          {@const isActive = currentNav && Object.keys(currentNav)[0] === identifier}
          {#if identifier}
            <MobileLink {identifier} {isActive} onclick={() => handleClick({ [identifier]: navigation })}>
              {$_(`navigation.${navigation.label}`)}
            </MobileLink>
          {/if}
        {/each}
      </div>
    </ScrollArea>
  </Sheet.Content>
</Sheet.Root>
