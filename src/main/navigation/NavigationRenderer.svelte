<script lang="ts">
import type { SvelteComponent } from 'svelte';
import { navigationStore } from '$lib/stores/navigation';

let CurrentComponent: SvelteComponent | undefined = $state(undefined);

navigationStore.subscribe(tab => {
  if (tab) {
    CurrentComponent = Object.values(tab)[0].component;
  }
});
</script>

<div class="container relative pb-10 pt-10">
  {#if CurrentComponent}
    <CurrentComponent></CurrentComponent>
  {/if}
</div>
