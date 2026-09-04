<script lang="ts">
let { onStart } = $props<{
	onStart?: (overrides?: { source?: string }) => Promise<void>;
}>();
</script>

<button data-testid="start-stream" onclick={() => void onStart?.()}>Start</button>
