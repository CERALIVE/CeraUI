<script lang="ts">
let { open = false }: { open?: boolean; [key: string]: unknown } = $props();
</script>

{#if open}<div data-testid="power-dialog-open"></div>{/if}
