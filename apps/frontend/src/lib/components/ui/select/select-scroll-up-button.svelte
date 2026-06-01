<script lang="ts">
import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
import { Select as SelectPrimitive } from 'bits-ui';

import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: WithoutChildrenOrChild<SelectPrimitive.ScrollUpButtonProps> = $props();
</script>

<SelectPrimitive.ScrollUpButton
	class={cn(
		"bg-popover top-0 z-10 flex w-full cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4",
		className,
	)}
	data-slot="select-scroll-up-button"
	bind:ref
	{...restProps}
>
	<ChevronUpIcon />
</SelectPrimitive.ScrollUpButton>
