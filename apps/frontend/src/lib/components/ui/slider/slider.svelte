<script lang="ts">
import { Slider as SliderPrimitive } from 'bits-ui';

import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

let {
	ref = $bindable(null),
	value = $bindable(),
	orientation = 'horizontal',
	class: className,
	...restProps
}: WithoutChildrenOrChild<SliderPrimitive.RootProps> = $props();

// bits-ui applies aria-label/aria-labelledby to the Root (a group), but the
// Thumb carries role="slider" and needs its OWN accessible name or axe flags
// `aria-input-field-name`. Forward the name attrs to the thumb so a labelled
// <Slider> yields a labelled thumb; undefined when none is passed (no-op).
const thumbProps = {
	'aria-label': (restProps as Record<string, unknown>)['aria-label'] as string | undefined,
	'aria-labelledby': (restProps as Record<string, unknown>)['aria-labelledby'] as
		| string
		| undefined,
};
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	class={cn(
		'relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col',
		className,
	)}
	data-slot="slider"
	{orientation}
	bind:ref
	bind:value={value as never}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			class={cn(
				'bg-muted bg-muted relative grow overflow-hidden rounded-full data-horizontal:h-1 data-horizontal:w-full data-horizontal:w-full data-vertical:h-full data-vertical:h-full data-vertical:w-1',
			)}
			data-orientation={orientation}
			data-slot="slider-track"
		>
			<SliderPrimitive.Range
				class={cn('bg-primary absolute select-none data-horizontal:h-full data-vertical:w-full')}
				data-slot="slider-range"
			/>
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				aria-label={thumbProps['aria-label']}
				aria-labelledby={thumbProps['aria-labelledby']}
				class="border-ring ring-ring/50 relative block size-3 shrink-0 rounded-full border bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
				data-slot="slider-thumb"
				index={thumb.index}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
