<script lang="ts">
import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';

import { cn, type WithoutChild } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	orientation = 'vertical',
	children,
	...restProps
}: WithoutChild<ScrollAreaPrimitive.ScrollbarProps> = $props();
</script>

<ScrollAreaPrimitive.Scrollbar
	class={cn(
		'flex touch-none p-px transition-colors select-none',
		orientation === 'vertical' && 'h-full w-2.5 border-s border-s-transparent',
		orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
		className,
	)}
	data-slot="scroll-area-scrollbar"
	{orientation}
	bind:ref
	{...restProps}
>
	{@render children?.()}
	<ScrollAreaPrimitive.Thumb
		class="bg-border relative flex-1 rounded-full"
		data-slot="scroll-area-thumb"
	/>
</ScrollAreaPrimitive.Scrollbar>
