<script lang="ts">
// Test-only fixture: throws during component initialization (render phase) so
// the surrounding <svelte:boundary> must catch it and show the fallback.
throw new Error('Intentional render error for boundary behavioral test');
</script>
