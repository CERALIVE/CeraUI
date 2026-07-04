<!--
  LiveCockpitStub.svelte — inert stand-in for LiveCockpit in the LiveView
  cockpit-switch tests. Ignores every prop except `summaryMode`, which it mirrors
  onto `data-summary-mode` so the post-stream summary-window test can assert the
  cockpit is held in summary-only mode after a stop.
-->
<script lang="ts">
const props: { summaryMode?: boolean } = $props();
</script>

<div data-testid="live-cockpit" data-summary-mode={props.summaryMode ? 'true' : 'false'}></div>
