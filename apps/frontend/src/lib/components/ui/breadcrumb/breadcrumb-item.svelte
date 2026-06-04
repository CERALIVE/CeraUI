<script lang="ts">
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
	class={cn('inline-flex items-center gap-1', className)}
	data-slot="breadcrumb-item"
	{...restProps}
>
	{@render children?.()}
</li>
