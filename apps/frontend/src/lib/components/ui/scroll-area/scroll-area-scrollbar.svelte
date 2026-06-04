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
		'flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent',
		className,
	)}
	data-orientation={orientation}
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
