<script lang="ts">
import type { HTMLAttributes } from 'svelte/elements';

import { cn, type WithElementRef } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {} = $props();
</script>

<div
	bind:this={ref}
	class={cn('text-muted-foreground px-1.5 py-1 text-xs', className)}
	data-slot="select-label"
	{...restProps}
>
	{@render children?.()}
</div>
