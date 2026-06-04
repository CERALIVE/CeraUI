<script lang="ts">
// Test-only fixture: mirrors App.svelte's wiring (the real top-level boundary)
// but wraps a child that throws on render, so the behavioral test can assert the
// recoverable fallback renders instead of a blank app.
import ErrorBoundary from '../ErrorBoundary.svelte';
import ThrowOnRender from './ThrowOnRender.svelte';
</script>

<ErrorBoundary>
	<ThrowOnRender />
</ErrorBoundary>
