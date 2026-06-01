<script lang="ts">
import { Progress as ProgressPrimitive } from 'bits-ui';

import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	max = 100,
	value,
	...restProps
}: WithoutChildrenOrChild<ProgressPrimitive.RootProps> = $props();
</script>

<ProgressPrimitive.Root
	class={cn(
		'bg-muted relative flex h-1 w-full items-center overflow-x-hidden rounded-full',
		className,
	)}
	data-slot="progress"
	{max}
	{value}
	bind:ref
	{...restProps}
>
	<div
		style:transform="translateX(-{100 - (100 * (value ?? 0)) / (max ?? 1)}%)"
		class="bg-primary size-full flex-1 transition-all"
		data-slot="progress-indicator"
	></div>
</ProgressPrimitive.Root>
