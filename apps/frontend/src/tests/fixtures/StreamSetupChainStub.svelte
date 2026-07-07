<!--
  StreamSetupChainStub.svelte — inert stand-in for StreamSetupChain carrying only
  its identifying testid, so IdleCockpit's DOM order can be asserted without
  mounting the real readiness/Start subtree.
-->
<script lang="ts">
const props = $props();
void props;
</script>

<div data-testid="stream-setup-chain"></div>
