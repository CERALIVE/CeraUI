<script lang="ts">
let { onviewraw }: { onviewraw: (around: unknown) => void } = $props();
</script>

<button data-testid="fake-events" onclick={() => onviewraw('around-page')} type="button">fake</button>
