<!--
  LowDiskBannerStub.svelte: stand-in for LowDiskBanner that always shows its
  action, so SettingsView's onViewLogs wiring is clickable without disk stats.
-->
<script lang="ts">
const { onViewLogs }: { onViewLogs: () => void } = $props();
</script>

<button data-testid="low-disk-view-logs" onclick={onViewLogs} type="button">low disk</button>
