<script lang="ts">
import { Collapsible as CollapsiblePrimitive } from 'bits-ui';

let { ref = $bindable(null), ...restProps }: CollapsiblePrimitive.TriggerProps = $props();
</script>

<CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" bind:ref {...restProps} />
