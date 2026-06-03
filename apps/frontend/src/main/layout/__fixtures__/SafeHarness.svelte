<script lang="ts">
// Test-only fixture: a non-throwing child through the same boundary. Control case
// proving the boundary is transparent on the happy path (renders children, no
// fallback).
import ErrorBoundary from '../ErrorBoundary.svelte';
</script>

<ErrorBoundary>
	<p data-testid="safe-child">All systems nominal</p>
</ErrorBoundary>
