<script lang="ts">
import { Select as SelectPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: SelectPrimitive.GroupProps = $props();
</script>

<SelectPrimitive.Group
	class={cn('scroll-my-1 p-1', className)}
	data-slot="select-group"
	bind:ref
	{...restProps}
/>
