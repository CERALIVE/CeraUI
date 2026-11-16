<!--
  ParamText.svelte — a translated sentence with its one data param in a <bdi>,
  so a version, slot or time keeps its own direction inside right-to-left text.
-->
<script lang="ts">
import { paramParts } from '$lib/device-logs/param-parts';

let { format, value }: { format: (value: string) => string; value: string } = $props();

const parts = $derived(paramParts(format));
</script>

{parts[0]}<bdi>{value}</bdi>{parts[1]}
