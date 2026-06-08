<script lang="ts">
import DisplayRefresh from '$lib/components/custom/DisplayRefresh.svelte';
import HudBar from './HudBar.svelte';

let { class: className, affordance = false }: { class?: string; affordance?: boolean } = $props();
</script>

{#if affordance}
	<!--
	  Affordance slot: the manual e-ink refresh control (Task 12). DisplayRefresh
	  is position:fixed and self-gates to the eink/mono profiles, so this slot is
	  mounted ONCE at the MainView root — never inside a breakpoint-hidden HUD
	  slot, which would `display:none` the fixed control at the wrong viewport.
	-->
	<DisplayRefresh />
{:else}
	<!--
	  Persistent HUD region. Mounts the live telemetry bar (HudBar) inside the
	  authenticated MainView shell so it persists across Live / Network / Settings.
	  Rendered in two responsive slots (desktop top bar / mobile bottom dock); each
	  slot owns its own HudBar instance, only one of which is visible at a time.
	-->
	<HudBar class={className} />
{/if}
