<!--
  SourceSectionStub.svelte — inert stand-in for SourceSection carrying only its
  identifying testid, so IdleCockpit's DOM order can be asserted without mounting
  the real source picker (QR effect, subscription graph).
-->
<script lang="ts">
const props = $props();
void props;
</script>

<div data-testid="source-section"></div>
