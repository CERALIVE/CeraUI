<script lang="ts">
import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
import { Accordion as AccordionPrimitive } from 'bits-ui';

import { cn, type WithoutChild } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	level = 3,
	children,
	...restProps
}: WithoutChild<AccordionPrimitive.TriggerProps> & {
	level?: AccordionPrimitive.HeaderProps['level'];
} = $props();
</script>

<AccordionPrimitive.Header class="flex" {level}>
	<AccordionPrimitive.Trigger
		class={cn(
			'focus-visible:ring-ring/50 focus-visible:border-ring focus-visible:after:border-ring **:data-[slot=accordion-trigger-icon]:text-muted-foreground group/accordion-trigger relative flex flex-1 items-start justify-between rounded-lg border border-transparent py-2.5 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4',
			className,
		)}
		data-slot="accordion-trigger"
		bind:ref
		{...restProps}
	>
		{@render children?.()}
		<ChevronDownIcon
			class="cn-accordion-trigger-icon pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
			data-slot="accordion-trigger-icon"
		/>
		<ChevronUpIcon
			class="cn-accordion-trigger-icon pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
			data-slot="accordion-trigger-icon"
		/>
	</AccordionPrimitive.Trigger>
</AccordionPrimitive.Header>
