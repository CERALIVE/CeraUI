<script lang="ts">
import HudBar from './HudBar.svelte';

let { class: className }: { class?: string } = $props();
</script>

<!--
  Persistent HUD region. Mounts the live telemetry bar (HudBar) inside the
  authenticated MainView shell so it persists across Live / Network / Settings.
  Rendered in two responsive slots (desktop top bar / mobile bottom dock); each
  slot owns its own HudBar instance, only one of which is visible at a time.
-->
<HudBar class={className} />
