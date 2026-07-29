<!--
  IngestStatsProbe.svelte — inert stand-in for IngestStats that mirrors the
  bitrate it was handed onto the DOM. IngestStats folds that value into its
  session peak/avg rollup, so the number LiveView threads down IS the number the
  post-stream summary reports.
-->
<script lang="ts">
const props: { bitrateKbps?: number } = $props();
</script>

<div data-testid="ingest-stats-probe" data-bitrate-kbps={props.bitrateKbps}></div>
