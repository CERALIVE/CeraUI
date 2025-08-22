<script lang="ts">
import { ChevronUp } from '@lucide/svelte';
import { Select as SelectPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: WithoutChildrenOrChild<SelectPrimitive.ScrollDownButtonProps> = $props();
</script>

<SelectPrimitive.ScrollUpButton
	class={cn('flex cursor-default items-center justify-center py-1', className)}
	bind:ref
	{...restProps}
>
	<ChevronUp class="size-4" />
</SelectPrimitive.ScrollUpButton>
