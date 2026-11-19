<!--
  EncoderDialogSaveStub.svelte: stand-in for EncoderDialog whose Save hands
  LiveView one bitrate change, so its save handler and toasts run for real.
-->
<script lang="ts">
let {
	open = $bindable(false),
	config: _config = $bindable(),
	onSave,
}: {
	open?: boolean;
	config?: unknown;
	onSave?: (value: { bitrate: number }) => void;
} = $props();
</script>

{#if open}
	<button data-testid="encoder-save" onclick={() => onSave?.({ bitrate: 5000 })} type="button">Save</button>
{/if}
