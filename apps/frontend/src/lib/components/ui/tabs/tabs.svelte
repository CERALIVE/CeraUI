<script lang="ts">
import { Tabs as TabsPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	value = $bindable(''),
	class: className,
	...restProps
}: TabsPrimitive.RootProps = $props();
</script>

<TabsPrimitive.Root
	class={cn('group/tabs flex gap-2 data-[orientation=horizontal]:flex-col', className)}
	data-slot="tabs"
	bind:ref
	bind:value
	{...restProps}
/>
