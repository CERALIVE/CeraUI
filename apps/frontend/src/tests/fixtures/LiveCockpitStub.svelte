<!--
  LiveCockpitStub.svelte — inert stand-in for LiveCockpit in the LiveView
  cockpit-switch test. Ignores every prop and renders only the identifying
  testid.
-->
<script lang="ts">
const props = $props();
void props;
</script>

<div data-testid="live-cockpit"></div>
