<script lang="ts">
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import type { HTMLLiAttributes } from 'svelte/elements';

import { cn, type WithElementRef } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLLiAttributes> = $props();
</script>

<li
	bind:this={ref}
	class={cn('[&>svg]:size-3.5', className)}
	aria-hidden="true"
	data-slot="breadcrumb-separator"
	role="presentation"
	{...restProps}
>
	{#if children}
		{@render children?.()}
	{:else}
		<ChevronRightIcon />
	{/if}
</li>
