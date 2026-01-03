<script lang="ts">
import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';

import { cn, type WithoutChild } from '$lib/utils.js';

import { Scrollbar } from './index.js';

let {
	ref = $bindable(null),
	viewportRef = $bindable(null),
	class: className,
	orientation = 'vertical',
	scrollbarXClasses = '',
	scrollbarYClasses = '',
	children,
	...restProps
}: WithoutChild<ScrollAreaPrimitive.RootProps> & {
	orientation?: 'vertical' | 'horizontal' | 'both' | undefined;
	scrollbarXClasses?: string | undefined;
	scrollbarYClasses?: string | undefined;
	viewportRef?: HTMLElement | null;
} = $props();
</script>

<ScrollAreaPrimitive.Root
	class={cn('relative', className)}
	data-slot="scroll-area"
	bind:ref
	{...restProps}
>
	<ScrollAreaPrimitive.Viewport
		class="ring-ring/10 dark:ring-ring/20 dark:outline-ring/40 outline-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] focus-visible:ring-4 focus-visible:outline-1"
		data-slot="scroll-area-viewport"
		bind:ref={viewportRef}
	>
		{@render children?.()}
	</ScrollAreaPrimitive.Viewport>
	{#if orientation === 'vertical' || orientation === 'both'}
		<Scrollbar class={scrollbarYClasses} orientation="vertical" />
	{/if}
	{#if orientation === 'horizontal' || orientation === 'both'}
		<Scrollbar class={scrollbarXClasses} orientation="horizontal" />
	{/if}
	<ScrollAreaPrimitive.Corner />
</ScrollAreaPrimitive.Root>
