<!--
  LogsDialog.svelte — System Logs, a full-viewport view opened from Settings.

  A thin AppDialog shell in the DeviceHealthDialog pattern: the header carries
  the stream-state pill at its inline end, and SystemLogsView owns the body. The
  two shipped log downloads live in its Downloads region. No title icon: the
  only lime in this view is the pill's Live state. Below 1024 px the header also
  holds the boot button (wider, the side column holds the boot picker).
  The chosen boot lives exactly as long as the open view: any close (its own or
  the parent's) or unmount drops it, so the next open starts on All boots, and
  while open, deleting stored history drops it once the device stops listing it.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { MediaQuery } from 'svelte/reactivity';

import { AppDialog } from '$lib/components/dialogs';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { onHistoryChanged } from '$lib/device-logs/history-bus';
import { WIDE_DESKTOP_QUERY } from '$lib/layout';
import { rpc } from '$lib/rpc/client';

import BootButton from '../system-logs/BootButton.svelte';
import StreamStatePill from '../system-logs/StreamStatePill.svelte';
import SystemLogsView from '../system-logs/SystemLogsView.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const wide = new MediaQuery(WIDE_DESKTOP_QUERY);

$effect(() => {
	if (!open) return;
	const stop = onHistoryChanged(() => void bootSelection.recheck(() => rpc.logs.boots()));
	return () => {
		stop();
		bootSelection.reset();
	};
});
</script>

<AppDialog bind:open fullscreen hideFooter title={m["settings.index.logs"]()}>
	{#snippet headerAside()}
		<StreamStatePill />
		{#if !wide.current}
			<BootButton />
		{/if}
	{/snippet}
	<SystemLogsView />
</AppDialog>
