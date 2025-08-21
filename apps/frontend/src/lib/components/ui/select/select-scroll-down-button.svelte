<script lang="ts">
import { ChevronDown } from '@lucide/svelte';
import { Select as SelectPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: WithoutChildrenOrChild<SelectPrimitive.ScrollDownButtonProps> = $props();
</script>

<SelectPrimitive.ScrollDownButton
	class={cn('flex cursor-default items-center justify-center py-1', className)}
	bind:ref
	{...restProps}
>
	<ChevronDown class="size-4" />
</SelectPrimitive.ScrollDownButton>
