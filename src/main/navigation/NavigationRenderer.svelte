<script lang="ts">
import type { Component } from 'svelte';

import { navigationStore } from '$lib/stores/navigation';

let CurrentComponent: Component | undefined = $state(undefined);

navigationStore.subscribe(tab => {
  if (tab) {
    CurrentComponent = Object.values(tab)[0].component;
  }
});
</script>

<div class="relative container pt-10 pb-10">
  {#if CurrentComponent}
    <CurrentComponent></CurrentComponent>
  {/if}
</div>
