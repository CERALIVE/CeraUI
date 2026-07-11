<script lang="ts">
import { onDestroy } from "svelte";
import { toast, type ToastT } from "svelte-sonner";

const messages = $derived(
	toast
		.getActiveToasts()
		.filter((item): item is ToastT & { title: string } => typeof item.title === "string"),
);

onDestroy(() => toast.dismiss());
</script>

<div class="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2" aria-live="assertive">
	{#each messages as message (message.id)}
		<div class="bg-destructive text-destructive-foreground rounded-md border px-4 py-3 text-sm shadow-lg" role="alert">
			{message.title}
		</div>
	{/each}
</div>
