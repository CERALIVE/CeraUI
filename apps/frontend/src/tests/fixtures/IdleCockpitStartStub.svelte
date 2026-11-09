<script lang="ts">
let { onStart }: {
	onStart?: (overrides?: { source?: string }) => Promise<void>;
} = $props();
</script>

<button type="button" data-testid="start-stream" onclick={() => void onStart?.()}>Start</button>
