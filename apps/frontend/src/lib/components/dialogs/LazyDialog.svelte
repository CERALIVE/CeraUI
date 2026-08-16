<!--
  LazyDialog.svelte — mounts a lazily-chunked config dialog.

  It replaces the static `<SomeDialog bind:open={x} … />` line one-for-one: the
  dialog's own props (including `bind:open`) still travel from the same call
  site, and the dialog component itself is unchanged. The chunk is fetched the
  first time `open` goes true and cached by the registry for the page's lifetime,
  so a second open costs nothing.

  Use this for every dialog whose ONLY two-way binding is `open`. A dialog with a
  second `bind:` (EncoderDialog's `bind:config`) mounts through the registry
  directly at its call site — a rest-spread cannot carry a binding.
-->
<script lang="ts">
import type { LazyDialogRegistration } from './lazy-dialog.svelte';
import LazyDialogFallback from './LazyDialogFallback.svelte';

interface Props {
	dialog: LazyDialogRegistration;
	open?: boolean;
	[key: string]: unknown;
}

let { dialog, open = $bindable(false), ...rest }: Props = $props();

// The open edge IS the load trigger — nothing else in the app knows a dialog is
// about to be needed.
$effect(() => {
	if (open) dialog.request();
});

const Dialog = $derived(dialog.current);
</script>

{#if Dialog}
	<Dialog bind:open {...rest} />
{:else if dialog.pending}
	<LazyDialogFallback bind:open failed={dialog.failed} onRetry={dialog.retry} />
{/if}
