<script lang="ts">
import type { Component } from 'svelte';

import { setupHashNavigation } from '$lib/helpers/NavigationHelper';
import { navigationStore } from '$lib/stores/navigation';

let CurrentComponent: Component | undefined = $state(undefined);

// Subscribe to navigation changes
$effect(() => {
  const unsubscribe = navigationStore.subscribe(tab => {
    if (tab) {
      CurrentComponent = Object.values(tab)[0].component;
    }
  });

  return unsubscribe;
});

// Setup hash navigation centrally (with initial state setting)
$effect(() => {
  const cleanup = setupHashNavigation(navigationStore, true);
  return cleanup;
});
</script>

<div class="relative container pt-10 pb-24">
  {#if CurrentComponent}
    <CurrentComponent></CurrentComponent>
  {/if}
</div>
