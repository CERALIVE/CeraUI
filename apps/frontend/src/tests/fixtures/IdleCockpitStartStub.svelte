<script lang="ts">
let { onStart }: {
	onStart?: (overrides?: { source?: string }) => Promise<void>;
} = $props();
</script>

<button data-testid="start-stream" onclick={() => void onStart?.()}>Start</button>
