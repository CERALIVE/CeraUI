<script lang="ts">
import type { Snippet } from 'svelte';

import ErrorBoundaryFallback from './ErrorBoundaryFallback.svelte';

// ONE top-level error boundary (Svelte 5 <svelte:boundary>). Wraps the whole
// app shell so a render/runtime fault in any descendant surfaces a recoverable
// fallback instead of a blank app. Do NOT add per-component boundaries — this
// is the single outermost catch.
let { children }: { children: Snippet } = $props();

// Log, never swallow. onerror also suppresses the boundary's default rethrow,
// so the fallback snippet renders instead of the app crashing.
function handleError(error: unknown): void {
	console.error('[CeraUI] Unhandled render error caught by top-level boundary:', error);
}
</script>

<svelte:boundary onerror={handleError}>
	{@render children()}

	{#snippet failed(error, reset)}
		<ErrorBoundaryFallback {error} {reset} />
	{/snippet}
</svelte:boundary>
