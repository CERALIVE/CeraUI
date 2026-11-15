<!--
  LogsDialog.svelte — System Logs, a full-viewport view opened from Settings.

  A thin AppDialog shell in the DeviceHealthDialog pattern: the header carries
  the stream-state pill at its inline end, and SystemLogsView owns the body. The
  two shipped log downloads live in its Downloads region. No title icon: the
  only lime in this view is the pill's Live state.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

import { AppDialog } from '$lib/components/dialogs';

import StreamStatePill from '../system-logs/StreamStatePill.svelte';
import SystemLogsView from '../system-logs/SystemLogsView.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();
</script>

<AppDialog bind:open fullscreen hideFooter title={m["settings.index.logs"]()}>
	{#snippet headerAside()}
		<StreamStatePill />
	{/snippet}
	<SystemLogsView />
</AppDialog>
