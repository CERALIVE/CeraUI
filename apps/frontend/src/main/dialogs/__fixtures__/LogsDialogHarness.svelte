<script lang="ts">
import LogsDialog from '../LogsDialog.svelte';

let open = $state(true);
</script>

<output data-testid="harness-open">{String(open)}</output>
<LogsDialog bind:open />
