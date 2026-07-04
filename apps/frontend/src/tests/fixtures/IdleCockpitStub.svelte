<!--
  IdleCockpitStub.svelte — inert stand-in for IdleCockpit in the LiveView
  cockpit-switch test. Ignores every prop and renders only the identifying
  testid so the parent's idle/live gate can be asserted without mounting the
  GoLiveCard/SourceSection/PreviewCanvas subtree.
-->
<script lang="ts">
const props = $props();
void props;
</script>

<div data-testid="idle-cockpit"></div>
