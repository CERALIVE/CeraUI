<!--
  Test host: owns System Logs' open state the way SettingsView owns `logsOpen`,
  and writes it like any state assignment, without a synchronous flush.
-->
<script lang="ts">
import type { LogsDialogContext } from '$lib/stores/dialog-request.svelte';

import LogsDialog from '../LogsDialog.svelte';

let open = $state(false);
let context = $state.raw<LogsDialogContext>();

export function show(next?: LogsDialogContext): void {
	context = next;
	open = true;
}

export function close(): void {
	open = false;
}
</script>

<LogsDialog bind:open {context} />
