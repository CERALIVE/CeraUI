<script lang="ts">
import { Collapsible as CollapsiblePrimitive } from 'bits-ui';

let {
	ref = $bindable(null),
	open = $bindable(false),
	...restProps
}: CollapsiblePrimitive.RootProps = $props();
</script>

<CollapsiblePrimitive.Root data-slot="collapsible" bind:ref bind:open {...restProps} />
