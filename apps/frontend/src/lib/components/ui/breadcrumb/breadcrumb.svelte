<script lang="ts">
import type { HTMLAttributes } from 'svelte/elements';

import type { WithElementRef } from '$lib/utils.js';
import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	children,
	...restProps
}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<nav
	bind:this={ref}
	class={cn('cn-breadcrumb', className)}
	aria-label="breadcrumb"
	data-slot="breadcrumb"
	{...restProps}
>
	{@render children?.()}
</nav>
