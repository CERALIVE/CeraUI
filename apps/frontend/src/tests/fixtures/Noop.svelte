<!--
  Noop.svelte — an inert stand-in component for unit tests.

  Used as the vi.mock replacement for heavy child components when a test needs to
  render a large parent in isolation (e.g. SettingsView) without mounting every
  dialog and its subscription graph. It accepts (and ignores) a bindable `open`
  so a `<Child bind:open={…} />` call site type-checks and mounts cleanly.
-->
<script lang="ts">
let { open = $bindable(false) }: { open?: boolean } = $props();
// `open` is intentionally unused — this is an inert test stub.
void open;
</script>
