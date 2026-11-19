<!--
  UpdatesDialogProbe.svelte: stand-in for the lazily loaded UpdatesDialog in the
  SettingsView deep-link tests. Prints whether SettingsView opened it.
-->
<script lang="ts">
const { open = false }: { open?: boolean } = $props();
</script>

<output data-open={String(open)} data-testid="updates-dialog-probe"></output>
