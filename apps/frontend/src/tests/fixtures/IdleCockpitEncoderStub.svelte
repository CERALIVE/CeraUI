<!--
  IdleCockpitEncoderStub.svelte: stand-in for IdleCockpit that only offers the
  encoder row's edit, so a test can open LiveView's EncoderDialog.
-->
<script lang="ts">
import type { ConfigRow } from '$main/live/StreamSettingsCard.svelte';

let { configRows = [] }: { configRows?: ConfigRow[] } = $props();
</script>

<button
	data-testid="open-encoder"
	onclick={() => configRows.find((row) => row.section === 'encoder')?.onEdit()}
	type="button">Encoder</button
>
