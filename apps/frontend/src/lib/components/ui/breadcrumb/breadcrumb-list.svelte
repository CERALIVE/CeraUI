<script lang="ts">
import type { HTMLOlAttributes } from 'svelte/elements';

import { cn, type WithElementRef } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLOlAttributes> = $props();
</script>

<ol
	bind:this={ref}
	class={cn(
		'text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm wrap-break-word',
		className,
	)}
	data-slot="breadcrumb-list"
	{...restProps}
>
	{@render children?.()}
</ol>
