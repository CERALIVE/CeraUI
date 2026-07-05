<!--
  EncoderDialogOpenStub.svelte — stand-in for EncoderDialog that surfaces its
  `open` state as a testid, so a test can assert whether the dialog opened. It
  declares `open`/`config` as bindable so LiveView's `bind:open`/`bind:config`
  call site mounts cleanly.
-->
<script lang="ts">
// `config`/`onSave` are declared bindable/accepted only so LiveView's
// `bind:config`/`onSave` call site mounts; this inert stub never reads them.
let {
	open = $bindable(false),
	config: _config = $bindable(),
	onSave: _onSave,
}: {
	open?: boolean;
	config?: unknown;
	onSave?: (value: unknown) => void;
} = $props();
</script>

{#if open}
	<div data-testid="encoder-dialog-open"></div>
{/if}
