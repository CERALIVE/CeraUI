<script lang="ts">
import { Tabs as TabsPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let { ref = $bindable(null), class: className, ...restProps }: TabsPrimitive.ListProps = $props();
</script>

<TabsPrimitive.List
	class={cn(
		'bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]',
		className,
	)}
	data-slot="tabs-list"
	bind:ref
	{...restProps}
/>
