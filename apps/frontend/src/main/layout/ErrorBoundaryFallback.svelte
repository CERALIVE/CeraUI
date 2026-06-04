<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

import { Button } from '$lib/components/ui/button';

// Rendered by the top-level <svelte:boundary> when a child throws during render.
// `reset` re-mounts the boundary's children — recoverable once the underlying
// cause clears (e.g. a transient store/render fault). `error` is logged by the
// boundary's onerror handler, not surfaced here (no raw stack to the operator).
let { reset }: { error: unknown; reset: () => void } = $props();
</script>

<div class="flex min-h-screen items-center justify-center p-6" role="alert">
	<div
		class="border-border bg-card w-full max-w-md rounded-xl border p-8 text-center shadow-sm"
	>
		<div
			class="bg-status-error/10 text-status-error mx-auto mb-5 flex size-12 items-center justify-center rounded-full"
		>
			<TriangleAlertIcon class="size-6" />
		</div>
		<h1 class="text-card-foreground text-xl font-semibold tracking-tight text-balance">
			{$LL.errorBoundary.title()}
		</h1>
		<p class="text-muted-foreground mx-auto mt-2 max-w-prose text-sm leading-relaxed text-pretty">
			{$LL.errorBoundary.description()}
		</p>
		<Button class="mt-6 w-full" onclick={reset}>
			{$LL.errorBoundary.retry()}
		</Button>
	</div>
</div>
