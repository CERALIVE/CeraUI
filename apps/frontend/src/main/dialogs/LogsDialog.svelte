<!--
  LogsDialog.svelte: System Logs, a full-viewport view opened from Settings.

  A thin AppDialog shell in the DeviceHealthDialog pattern: the header carries
  the stream-state pill at its inline end, and SystemLogsView owns the body. The
  two shipped log downloads live in its Downloads region. No title icon: lime
  marks the pill's Live state and the one primary sharing action, Export logs. Below 1024 px the header also
  holds the boot button (wider, the side column holds the boot picker).
  The chosen boot lives exactly as long as the open view: any close (its own or
  the parent's) or unmount drops it, so the next open starts on All boots, and
  while open, deleting stored history drops it once the device stops listing it.
  The open generation is derived from `open` itself, so the write that closes
  the dialog ends it at once, before the update flush tears the view down.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { onDestroy } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import { AppDialog } from '$lib/components/dialogs';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { onHistoryChanged } from '$lib/device-logs/history-bus';
import { WIDE_DESKTOP_QUERY } from '$lib/layout';
import { rpc } from '$lib/rpc/client';
import type { LogsDialogContext } from '$lib/stores/dialog-request.svelte';

import BootButton from '../system-logs/BootButton.svelte';
import StreamStatePill from '../system-logs/StreamStatePill.svelte';
import SystemLogsView from '../system-logs/SystemLogsView.svelte';

interface Props {
	open?: boolean;
	/** Where the view opens, from a deep link; absent from the Settings entry. */
	context?: LogsDialogContext;
}

let { open = $bindable(false), context }: Props = $props();

const wide = new MediaQuery(WIDE_DESKTOP_QUERY);
// Use the System Logs palette for text selection inside the dialog subtree;
// scrollbars inherit the page's graphite palette from app.css.
const SURFACES = 'selection:bg-status-info/30 selection:text-foreground';

// A new object whenever `open` is written, null while closed: a result checked after a close or a
// reopen is stale in that same call, whoever wrote it (this dialog's control, Escape, the parent).
const generation = $derived(open ? {} : null);
onDestroy(bootSelection.attach(() => generation));

$effect(() => {
	if (!open) return;
	const stop = onHistoryChanged(() => void bootSelection.recheck(() => rpc.logs.boots()));
	return () => {
		stop();
		bootSelection.reset();
	};
});
</script>

<AppDialog bind:open contentClass={SURFACES} fullscreen hideFooter title={m["settings.index.logs"]()}>
	{#snippet headerAside()}
		<StreamStatePill />
		{#if generation !== null && !wide.current}
			{#key generation}
				<BootButton />
			{/key}
		{/if}
	{/snippet}
	<!-- One view per open generation: a close retires it while the shell animates out, and a reopen,
	     even within the same turn, mounts a fresh one. -->
	{#if generation !== null}
		{#key generation}
			<SystemLogsView {context} />
		{/key}
	{/if}
</AppDialog>
