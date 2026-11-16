<!--
  LogsDialogProbe.svelte — stand-in for the lazily loaded LogsDialog in the
  SettingsView deep-link tests. Prints the props SettingsView hands it.
-->
<script lang="ts">
const { open = false, context }: { open?: boolean; context?: unknown } = $props();
</script>

<output data-context={JSON.stringify(context ?? null)} data-open={String(open)} data-testid="logs-dialog-probe"></output>
