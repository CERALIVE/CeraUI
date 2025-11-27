<script lang="ts">
import { Collapsible as CollapsiblePrimitive } from 'bits-ui';

let { ref = $bindable(null), ...restProps }: CollapsiblePrimitive.ContentProps = $props();
</script>

<CollapsiblePrimitive.Content data-slot="collapsible-content" bind:ref {...restProps} />
