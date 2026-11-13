<script lang="ts">
let { onSwitch }: {
	onSwitch: (inputId: string) => Promise<void>;
} = $props();
</script>

<button type="button" onclick={() => void onSwitch('video63')}>Switch input</button>
