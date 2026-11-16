<!--
  LabeledSlider.svelte — the single-value horizontal slider of the Live screen
  and the Encoder dialog, with its accessible name on the thumb.

  The shadcn `Slider` primitive forwards every attribute to its root, but the
  element a screen reader focuses and announces is the THUMB (`role="slider"`),
  so a label on the root names nothing. This renders the same bits-ui parts with
  the name, description and value text on the thumb, and with the reading
  direction of the active locale: bits-ui runs left to right unless told, so in
  Arabic it would run against the mirrored layout around it.

  Every other attribute (test id, id, key and pointer listeners) goes to the root,
  as with the primitive.
-->
<script lang="ts">
import { directionFor, getLocale } from '@ceraui/i18n/svelte';
import { Slider as SliderPrimitive } from 'bits-ui';

import { cn, type WithoutChildrenOrChild } from '$lib/utils';

type RootAttributes = Omit<
	WithoutChildrenOrChild<SliderPrimitive.RootProps>,
	'dir' | 'disabled' | 'max' | 'min' | 'onValueChange' | 'onValueCommit' | 'step' | 'type' | 'value'
>;

interface Props extends RootAttributes {
	value: number;
	min: number;
	max: number;
	step: number;
	/** The thumb's accessible name. */
	label: string;
	/** Ids of the elements describing the thumb. */
	describedBy?: string;
	/** The thumb's value as words, when the number alone does not say it. */
	valueText?: string;
	disabled?: boolean;
	onValueChange?: (value: number) => void;
	onValueCommit?: (value: number) => void;
}

const {
	value,
	min,
	max,
	step,
	label,
	describedBy,
	valueText,
	disabled = false,
	onValueChange,
	onValueCommit,
	class: className,
	...rest
}: Props = $props();
</script>

<SliderPrimitive.Root
	{...rest}
	class={cn(
		'relative flex min-h-6 w-full min-w-0 touch-none items-center select-none data-disabled:opacity-50',
		className,
	)}
	data-slot="slider"
	dir={directionFor(getLocale())}
	{disabled}
	{max}
	{min}
	{onValueChange}
	{onValueCommit}
	{step}
	type="single"
	{value}
>
	{#snippet children({ thumbItems })}
		<span class="bg-muted relative h-1 w-full grow overflow-hidden rounded-full" data-slot="slider-track">
			<SliderPrimitive.Range class="bg-primary absolute h-full select-none" data-slot="slider-range" />
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				aria-describedby={describedBy}
				aria-label={label}
				aria-valuetext={valueText}
				class="border-ring ring-ring/50 relative block size-3 shrink-0 rounded-full border bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
				data-slot="slider-thumb"
				index={thumb.index}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
